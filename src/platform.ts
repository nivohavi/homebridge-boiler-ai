import {
  API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig,
  Service, Characteristic,
} from 'homebridge';
import { PLATFORM_NAME, PLUGIN_NAME, BoilerAIConfig, deriveSchedule, heatingRate, parseTimeOfDay } from './settings';
import { callAI } from './ai';
import { fetchWeather, estimateSolarGainPerHour } from './weather';
import { estimateTankTemp } from './tempModel';
import { loadState, saveState, appendHistory } from './state';
import { sendWebhook } from './boiler';
import { switcherTurnOn, switcherTurnOff } from './switcher';
import { buildPrompt, parseAIResponse } from './prompt';
import { BoilerAccessory } from './boilerAccessory';

export class BoilerAIPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  private readonly config: BoilerAIConfig;
  private readonly schedule: string[];
  private readonly storagePath: string;

  private boilerRunning = false;
  private decisionLock = false;
  private tankAutoDetected = false;
  private cycleTimer?: NodeJS.Timeout;
  private watchdogTimer?: NodeJS.Timeout;
  private schedulerTimer?: NodeJS.Timeout;
  private accessory?: BoilerAccessory;

  constructor(
    public readonly log: Logger,
    platformConfig: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.storagePath = api.user.storagePath();

    // Map platform config to typed config
    this.config = {
      name: platformConfig.name || 'Boiler AI',
      location: platformConfig.location || 'Givatayim',
      timezone: platformConfig.timezone || 'Asia/Jerusalem',
      geminiApiKey: platformConfig.geminiApiKey,
      xaiApiKey: platformConfig.xaiApiKey,
      tank: {
        liters: platformConfig.tank?.liters || 120,
        heaterKw: platformConfig.tank?.heaterKw || 2.5,
        solar: platformConfig.tank?.solar !== false, // default true
      },
      boilerPlug: {
        onUrl: platformConfig.boilerPlug?.onUrl || '',
        offUrl: platformConfig.boilerPlug?.offUrl || '',
        method: platformConfig.boilerPlug?.method || 'GET',
        headers: platformConfig.boilerPlug?.headers,
        body: platformConfig.boilerPlug?.body,
      },
      switcher: platformConfig.switcher?.deviceId ? {
        deviceId: platformConfig.switcher.deviceId,
        deviceIp: platformConfig.switcher.deviceIp,
        token: platformConfig.switcher.token,
      } : undefined,
      usage: platformConfig.usage || [
        { time: '06:00', label: 'Morning wash', liters: 30, temp: 38 },
        { time: '18:30', label: 'Kid bath', liters: 50, temp: 45 },
        { time: '22:00', label: 'Showers', liters: 120, temp: 50 },
      ],
      maxDurationMinutes: platformConfig.maxDurationMinutes || 90,
      aiTemperature: platformConfig.aiTemperature || 0.3,
    };

    this.schedule = (platformConfig.schedule as string[]) || deriveSchedule(this.config.usage);

    // Track if user explicitly configured tank
    this.tankAutoDetected = !platformConfig.tank?.liters && !platformConfig.tank?.heaterKw;

    this.api.on('didFinishLaunching', async () => {
      // Auto-detect tank specs from location if not configured
      if (this.tankAutoDetected) {
        await this.detectTankSpecs();
      }

      this.recoverFromCrash();
      this.startScheduler();
      const control = this.config.switcher ? `switcher(${this.config.switcher.deviceId})` : 'HTTP webhook';
      this.log.info(
        `Boiler AI online (location=${this.config.location}, tank=${this.config.tank.liters}L/${this.config.tank.heaterKw}kW, control=${control}, schedule=${JSON.stringify(this.schedule)})`,
      );
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info('Restoring accessory:', accessory.displayName);
    this.accessory = new BoilerAccessory(this, accessory, this.log);
  }

  discoverDevices(): void {
    // Not used — we register in didFinishLaunching via configureAccessory
  }

  // Called by Homebridge after launch if no cached accessory exists
  private ensureAccessory(): void {
    if (this.accessory) return;

    const uuid = this.api.hap.uuid.generate('boiler-ai-switch');
    const acc = new this.api.platformAccessory(this.config.name, uuid);
    this.accessory = new BoilerAccessory(this, acc, this.log);
    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [acc]);
  }

  // Auto-detect tank specs based on timezone/location
  private async detectTankSpecs(): Promise<void> {
    // Check if we already detected and cached specs
    const state = loadState(this.storagePath);
    if ((state as any).tankSpecsDetected) {
      this.config.tank.liters = (state as any).detectedLiters || 120;
      this.config.tank.heaterKw = (state as any).detectedHeaterKw || 2.5;
      this.config.tank.solar = (state as any).detectedSolar !== false;
      this.log.info(`TANK: using cached specs: ${this.config.tank.liters}L, ${this.config.tank.heaterKw}kW, solar=${this.config.tank.solar}`);
      return;
    }

    // Regional defaults based on timezone — more reliable than AI for factual specs
    const regionDefaults: Record<string, { liters: number; kw: number; solar: boolean }> = {
      // Israel
      'Asia/Jerusalem': { liters: 150, kw: 2.5, solar: true },
      // Australia
      'Australia/Sydney': { liters: 160, kw: 3.6, solar: true },
      'Australia/Melbourne': { liters: 160, kw: 3.6, solar: true },
      'Australia/Brisbane': { liters: 160, kw: 3.6, solar: true },
      'Australia/Perth': { liters: 160, kw: 3.6, solar: true },
      // UK / Ireland
      'Europe/London': { liters: 150, kw: 3.0, solar: false },
      'Europe/Dublin': { liters: 150, kw: 3.0, solar: false },
      // Southern Europe (solar common)
      'Europe/Athens': { liters: 150, kw: 2.0, solar: true },
      'Europe/Istanbul': { liters: 150, kw: 2.0, solar: true },
      'Europe/Rome': { liters: 80, kw: 1.5, solar: false },
      'Europe/Madrid': { liters: 100, kw: 1.5, solar: true },
      // Central / Northern Europe
      'Europe/Berlin': { liters: 150, kw: 2.0, solar: false },
      'Europe/Paris': { liters: 150, kw: 2.0, solar: false },
      'Europe/Amsterdam': { liters: 120, kw: 2.0, solar: false },
      'Europe/Stockholm': { liters: 200, kw: 3.0, solar: false },
      // North America
      'America/New_York': { liters: 190, kw: 4.5, solar: false },
      'America/Chicago': { liters: 190, kw: 4.5, solar: false },
      'America/Los_Angeles': { liters: 190, kw: 4.5, solar: false },
      'America/Toronto': { liters: 190, kw: 4.5, solar: false },
      // South Africa
      'Africa/Johannesburg': { liters: 150, kw: 2.0, solar: true },
      // India
      'Asia/Kolkata': { liters: 25, kw: 2.0, solar: true },
    };

    const specs = regionDefaults[this.config.timezone];

    if (specs) {
      this.config.tank.liters = specs.liters;
      this.config.tank.heaterKw = specs.kw;
      this.config.tank.solar = specs.solar;
      this.log.info(`TANK: regional defaults for ${this.config.timezone}: ${specs.liters}L, ${specs.kw}kW, solar=${specs.solar}`);
    } else {
      // Unknown timezone — try AI as fallback
      try {
        this.log.info(`TANK: unknown region (${this.config.timezone}), asking AI...`);
        const prompt = `What is the most common residential hot water tank in the country with timezone ${this.config.timezone}? Reply ONLY: LITERS|KW|SOLAR (e.g. 150|2.5|true). KW must be in kilowatts not watts.`;
        const raw = await callAI(prompt, 15, this.config.xaiApiKey, this.config.geminiApiKey, 0.0);
        const match = raw.trim().match(/(\d+)\s*\|\s*([\d.]+)\s*\|\s*(true|false)/i);
        if (match) {
          let kw = parseFloat(match[2]);
          if (kw > 100) kw = kw / 1000;
          const liters = parseInt(match[1], 10);
          if (liters >= 30 && liters <= 500 && kw >= 0.5 && kw <= 10) {
            this.config.tank.liters = liters;
            this.config.tank.heaterKw = kw;
            this.config.tank.solar = match[3].toLowerCase() === 'true';
            this.log.info(`TANK: AI detected for ${this.config.timezone}: ${liters}L, ${kw}kW, solar=${this.config.tank.solar}`);
          }
        }
      } catch (err) {
        this.log.warn(`TANK: auto-detect failed, using defaults (120L, 2.5kW): ${(err as Error).message}`);
      }
    }

    // Cache result
    (state as any).tankSpecsDetected = true;
    (state as any).detectedLiters = this.config.tank.liters;
    (state as any).detectedHeaterKw = this.config.tank.heaterKw;
    (state as any).detectedSolar = this.config.tank.solar;
    saveState(this.storagePath, state);
  }

  // Send on/off command through the configured control method
  private async sendBoilerOn(minutes?: number): Promise<void> {
    if (this.config.switcher) {
      await switcherTurnOn(this.config.switcher, minutes || this.config.maxDurationMinutes, this.log);
    } else {
      await sendWebhook(true, this.config.boilerPlug, this.log);
    }
  }

  private async sendBoilerOff(): Promise<void> {
    if (this.config.switcher) {
      await switcherTurnOff(this.config.switcher, this.log);
    } else {
      await sendWebhook(false, this.config.boilerPlug, this.log);
    }
  }

  isBoilerOn(): boolean {
    return this.boilerRunning;
  }

  async triggerDecisionCycle(trigger: string): Promise<string> {
    if (this.decisionLock) {
      this.log.warn('Decision cycle already in progress');
      return 'busy';
    }
    this.decisionLock = true;

    try {
      const now = new Date();
      const weather = await fetchWeather(this.config.location);
      const state = loadState(this.storagePath);

      let solarGain = 0;
      if (this.config.tank.solar) {
        solarGain = estimateSolarGainPerHour(weather, now.getMonth());
      }
      const tankTemp = estimateTankTemp(state, weather, now, this.config.tank, this.config.timezone);

      // Persist estimate
      state.lastEstimatedTemp = tankTemp;
      state.lastEstimatedAt = now.toISOString();
      saveState(this.storagePath, state);

      const prompt = buildPrompt(now, weather, tankTemp, solarGain, state, this.config, this.config.timezone);

      const raw = await callAI(
        prompt, 30,
        this.config.xaiApiKey, this.config.geminiApiKey,
        this.config.aiTemperature, this.log,
      );

      this.log.info(`AI RAW RESPONSE: ${raw}`);

      const { minutes, report } = parseAIResponse(raw, this.config.maxDurationMinutes);

      this.log.info(`DECISION: ${minutes} mins | tank ~${Math.round(tankTemp)}°C | ${weather.raw} | trigger: ${trigger}`);

      if (minutes > 0) {
        await this.startBoilerCycle(minutes, trigger, weather, report);
      }

      return report;
    } catch (err) {
      this.log.error(`Decision cycle failed: ${(err as Error).message}`);
      return `error: ${(err as Error).message}`;
    } finally {
      this.decisionLock = false;
    }
  }

  private async startBoilerCycle(
    minutes: number, trigger: string, weather: { raw: string; tempC: number; uvIndex: number; condition: string },
    report: string,
  ): Promise<void> {
    if (this.boilerRunning) {
      this.log.warn('Boiler already running — ignoring');
      return;
    }

    let capped = minutes;
    if (capped > this.config.maxDurationMinutes) {
      this.log.warn(`SAFETY: capped ${minutes} to ${this.config.maxDurationMinutes} min`);
      capped = this.config.maxDurationMinutes;
    }

    await this.sendBoilerOn(capped);

    this.boilerRunning = true;
    const startTime = new Date();
    this.accessory?.updateState(true);

    // Persist ON state
    const state = loadState(this.storagePath);
    state.boilerOn = true;
    state.runStartedAt = startTime.toISOString();
    state.runDurationMin = capped;
    saveState(this.storagePath, state);

    this.log.info(`BOILER ON: ${capped} min cycle (trigger: ${trigger})`);

    // Cycle timer
    this.cycleTimer = setTimeout(() => {
      this.finishCycle(capped, trigger, weather, report, startTime);
    }, capped * 60 * 1000);

    // Watchdog
    this.watchdogTimer = setTimeout(() => {
      if (this.boilerRunning) {
        this.log.warn('WATCHDOG: force-stopping boiler');
        this.stopBoiler();
      }
    }, (this.config.maxDurationMinutes + 5) * 60 * 1000);
  }

  private async finishCycle(
    minutes: number, trigger: string,
    weather: { raw: string; tempC: number; uvIndex: number; condition: string },
    report: string, startTime: Date,
  ): Promise<void> {
    if (!this.boilerRunning) return;

    try {
      await this.sendBoilerOff();
    } catch (err) {
      this.log.error(`CRITICAL: could not turn boiler OFF: ${(err as Error).message}`);
      // Emergency retry
      setTimeout(async () => {
        try {
          await this.sendBoilerOff();
        } catch (e) {
          this.log.error(`EMERGENCY: second OFF attempt failed: ${(e as Error).message}`);
        }
      }, 30000);
    }

    this.boilerRunning = false;
    this.accessory?.updateState(false);
    if (this.watchdogTimer) clearTimeout(this.watchdogTimer);

    const state = loadState(this.storagePath);
    state.boilerOn = false;
    state.runStartedAt = undefined;
    state.runDurationMin = undefined;

    appendHistory(state, {
      startedAt: startTime.toISOString(),
      finishedAt: new Date().toISOString(),
      durationMins: minutes,
      weather: weather.raw,
      tempC: weather.tempC,
      uvIndex: weather.uvIndex,
      condition: weather.condition,
      aiReport: report,
      trigger,
    });

    // Update temp estimate with heating gain
    const rate = heatingRate(this.config.tank);
    if (state.lastEstimatedTemp > 0) {
      state.lastEstimatedTemp += minutes * rate;
    } else {
      const month = startTime.getMonth() + 1;
      const baseTemp = (month >= 5 && month <= 9) ? 25 : 20;
      state.lastEstimatedTemp = baseTemp + minutes * rate;
    }
    if (state.lastEstimatedTemp > 70) state.lastEstimatedTemp = 70;
    state.lastEstimatedAt = new Date().toISOString();

    saveState(this.storagePath, state);
    this.log.info(`BOILER OFF: finished ${minutes} min cycle (trigger: ${trigger})`);
  }

  async stopBoiler(): Promise<void> {
    this.boilerRunning = false;
    this.accessory?.updateState(false);
    if (this.cycleTimer) clearTimeout(this.cycleTimer);
    if (this.watchdogTimer) clearTimeout(this.watchdogTimer);

    try {
      await this.sendBoilerOff();
    } catch (err) {
      this.log.error(`EMERGENCY STOP: failed: ${(err as Error).message}`);
    }

    const state = loadState(this.storagePath);
    state.boilerOn = false;
    state.runStartedAt = undefined;
    state.runDurationMin = undefined;
    saveState(this.storagePath, state);

    this.log.info('EMERGENCY STOP: boiler forced OFF');
  }

  private recoverFromCrash(): void {
    const state = loadState(this.storagePath);
    if (state.boilerOn) {
      this.log.warn('RECOVERY: boiler was ON from previous crash — sending OFF');
      this.sendBoilerOff().catch(err => {
        this.log.error(`RECOVERY: failed to send OFF: ${(err as Error).message}`);
      });
      state.boilerOn = false;
      state.runStartedAt = undefined;
      state.runDurationMin = undefined;
      saveState(this.storagePath, state);
    }
    this.ensureAccessory();
  }

  private startScheduler(): void {
    this.log.info(`SCHEDULER: active with check times ${JSON.stringify(this.schedule)}`);
    this.scheduleNext();
  }

  private scheduleNext(): void {
    const now = new Date();
    const nowStr = now.toLocaleTimeString('en-GB', {
      timeZone: this.config.timezone, hour: '2-digit', minute: '2-digit',
    });
    const nowMins = parseTimeOfDay(nowStr);

    let nextTime: string | null = null;
    let sleepMs = 0;

    for (const ct of this.schedule) {
      const ctMins = parseTimeOfDay(ct);
      if (ctMins > nowMins) {
        nextTime = ct;
        sleepMs = (ctMins - nowMins) * 60 * 1000;
        break;
      }
    }

    if (!nextTime) {
      // All checks passed — next is first check tomorrow
      const firstMins = parseTimeOfDay(this.schedule[0]);
      sleepMs = ((24 * 60 - nowMins) + firstMins) * 60 * 1000;
      nextTime = this.schedule[0] + ' (tomorrow)';
    }

    this.log.info(`SCHEDULER: next check at ${nextTime} (sleeping ${Math.round(sleepMs / 60000)} min)`);

    this.schedulerTimer = setTimeout(async () => {
      const trigger = 'scheduler:' + new Date().toLocaleTimeString('en-GB', {
        timeZone: this.config.timezone, hour: '2-digit', minute: '2-digit',
      });
      this.log.info('SCHEDULER: running automatic check');
      const report = await this.triggerDecisionCycle(trigger);
      this.log.info(`SCHEDULER: completed — ${report.slice(0, 100)}${report.length > 100 ? '...' : ''}`);
      this.scheduleNext();
    }, sleepMs);
  }
}
