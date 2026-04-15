import {
  API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig,
  Service, Characteristic,
} from 'homebridge';
import { PLATFORM_NAME, PLUGIN_NAME, BoilerAIConfig, deriveSchedule, heatingRate, parseTimeOfDay } from './settings';
import { callAI } from './ai';
import { fetchWeather, fetchHourlyWeather, estimateSolarGainPerHour } from './weather';
import { estimateTankTemp } from './tempModel';
import { loadState, saveState, appendHistory, BoilerState } from './state';
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

  // In-memory state — single source of truth, avoids load/save race conditions (#12)
  private state: BoilerState;

  private boilerRunning = false;
  private tankAutoDetected = false;
  private cycleTimer?: NodeJS.Timeout;
  private watchdogTimer?: NodeJS.Timeout;
  private schedulerTimer?: NodeJS.Timeout;
  private accessory?: BoilerAccessory;

  // Promise-based decision lock — async-safe (#4)
  private decisionPromise: Promise<string> | null = null;

  constructor(
    public readonly log: Logger,
    platformConfig: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.storagePath = api.user.storagePath();

    // Validate location (#11)
    const location = (platformConfig.location || '').trim();
    if (!location) {
      this.log.error('CONFIG: location is required');
    }

    // Clamp maxDurationMinutes at runtime (#6)
    const maxDuration = Math.max(10, Math.min(120, platformConfig.maxDurationMinutes || 90));

    // Map platform config to typed config
    this.config = {
      name: platformConfig.name || 'Boiler AI',
      location: location || 'Givatayim',
      timezone: platformConfig.timezone || 'Asia/Jerusalem',
      geminiApiKey: platformConfig.geminiApiKey,
      xaiApiKey: platformConfig.xaiApiKey,
      weatherApiKey: platformConfig.weatherApiKey,
      tank: {
        liters: platformConfig.tank?.liters || 120,
        heaterKw: platformConfig.tank?.heaterKw || 2.5,
        solar: platformConfig.tank?.solar !== false,
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
      maxDurationMinutes: maxDuration,
      aiTemperature: platformConfig.aiTemperature || 0.3,
      dryRun: platformConfig.dryRun === true,
    };

    // Validate webhook URLs (#5)
    if (!this.config.switcher) {
      this.validatePlugUrls();
    }

    this.schedule = (platformConfig.schedule as string[]) || deriveSchedule(this.config.usage);
    this.tankAutoDetected = !platformConfig.tank?.liters && !platformConfig.tank?.heaterKw;

    // Load state once into memory (#12)
    this.state = loadState(this.storagePath);

    this.api.on('didFinishLaunching', async () => {
      // Startup validation (#14, #15)
      if (!this.config.geminiApiKey && !this.config.xaiApiKey) {
        this.log.error('CONFIG: no AI API key set — configure geminiApiKey or xaiApiKey');
      }
      if (!this.config.dryRun && !this.config.switcher && (!this.config.boilerPlug.onUrl || !this.config.boilerPlug.offUrl)) {
        this.log.error('CONFIG: no boiler control configured — set switcher.deviceId or both boilerPlug.onUrl and boilerPlug.offUrl');
      }

      if (this.tankAutoDetected) {
        await this.detectTankSpecs();
      }

      this.recoverFromCrash();
      this.startScheduler();
      const control = this.config.dryRun ? 'DRY RUN'
        : this.config.switcher ? `switcher(${this.config.switcher.deviceId})` : 'HTTP webhook';
      this.log.info(
        `Boiler AI online (location=${this.config.location}, tank=${this.config.tank.liters}L/${this.config.tank.heaterKw}kW, control=${control}, schedule=${JSON.stringify(this.schedule)})`,
      );
    });

    // Shutdown handler — send OFF if boiler is running (#9)
    this.api.on('shutdown', async () => {
      this.log.info('SHUTDOWN: cleaning up');
      if (this.schedulerTimer) clearTimeout(this.schedulerTimer);
      if (this.cycleTimer) clearTimeout(this.cycleTimer);

      if (this.boilerRunning) {
        this.log.warn('SHUTDOWN: boiler is running — sending OFF');
        try {
          await this.sendBoilerOff();
          this.boilerRunning = false;
          this.state.boilerOn = false;
          this.state.runStartedAt = undefined;
          this.state.runDurationMin = undefined;
          this.persistState();
        } catch (err) {
          this.log.error(`SHUTDOWN: failed to send OFF: ${(err as Error).message}`);
          // Leave boilerOn=true so recoverFromCrash picks it up next startup
        }
      }

      if (this.watchdogTimer) clearTimeout(this.watchdogTimer);
    });
  }

  // Validate plug URLs have http/https protocol (#5)
  private validatePlugUrls(): void {
    for (const [label, url] of [['onUrl', this.config.boilerPlug.onUrl], ['offUrl', this.config.boilerPlug.offUrl]]) {
      if (!url) continue;
      try {
        const parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol)) {
          this.log.error(`CONFIG: boilerPlug.${label} must use http or https, got: ${parsed.protocol}`);
        }
      } catch {
        this.log.error(`CONFIG: boilerPlug.${label} is not a valid URL: ${url}`);
      }
    }
  }

  // Save in-memory state to disk
  private persistState(): void {
    saveState(this.storagePath, this.state);
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info('Restoring accessory:', accessory.displayName);
    this.accessory = new BoilerAccessory(this, accessory, this.log);
  }

  discoverDevices(): void {
    // Not used
  }

  private ensureAccessory(): void {
    if (this.accessory) return;
    const uuid = this.api.hap.uuid.generate('boiler-ai-switch');
    const acc = new this.api.platformAccessory(this.config.name, uuid);
    this.accessory = new BoilerAccessory(this, acc, this.log);
    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [acc]);
  }

  // Auto-detect tank specs based on timezone/location
  private async detectTankSpecs(): Promise<void> {
    if ((this.state as any).tankSpecsDetected) {
      this.config.tank.liters = (this.state as any).detectedLiters || 120;
      this.config.tank.heaterKw = (this.state as any).detectedHeaterKw || 2.5;
      this.config.tank.solar = (this.state as any).detectedSolar !== false;
      this.log.info(`TANK: using cached specs: ${this.config.tank.liters}L, ${this.config.tank.heaterKw}kW, solar=${this.config.tank.solar}`);
      return;
    }

    const regionDefaults = require('./regionDefaults.json') as Record<string, { liters: number; kw: number; solar: boolean }>;
    const specs = regionDefaults[this.config.timezone];

    if (specs) {
      this.config.tank.liters = specs.liters;
      this.config.tank.heaterKw = specs.kw;
      this.config.tank.solar = specs.solar;
      this.log.info(`TANK: regional defaults for ${this.config.timezone}: ${specs.liters}L, ${specs.kw}kW, solar=${specs.solar}`);
    } else {
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

    (this.state as any).tankSpecsDetected = true;
    (this.state as any).detectedLiters = this.config.tank.liters;
    (this.state as any).detectedHeaterKw = this.config.tank.heaterKw;
    (this.state as any).detectedSolar = this.config.tank.solar;
    this.persistState();
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

  // Persistent OFF retry — keeps trying until success (#3)
  private async sendBoilerOffWithRetries(maxAttempts: number, delayMs: number): Promise<boolean> {
    for (let i = 1; i <= maxAttempts; i++) {
      try {
        await this.sendBoilerOff();
        return true;
      } catch (err) {
        this.log.error(`OFF attempt ${i}/${maxAttempts} failed: ${(err as Error).message}`);
        if (i < maxAttempts) {
          await new Promise(r => setTimeout(r, delayMs));
        }
      }
    }
    return false;
  }

  isBoilerOn(): boolean {
    return this.boilerRunning;
  }

  // Promise-based lock — async-safe (#4)
  async triggerDecisionCycle(trigger: string): Promise<string> {
    if (this.decisionPromise) {
      this.log.warn('Decision cycle already in progress');
      return 'busy';
    }

    this.decisionPromise = this._runDecisionCycle(trigger);
    try {
      return await this.decisionPromise;
    } finally {
      this.decisionPromise = null;
    }
  }

  private async _runDecisionCycle(trigger: string): Promise<string> {
    try {
      const now = new Date();
      const { merged: weather, sourceDetails } = await fetchWeather(this.config.location, this.config.weatherApiKey);
      for (const detail of sourceDetails) {
        this.log.info(`WEATHER: ${detail}`);
      }
      const hourly = this.config.tank.solar
        ? await fetchHourlyWeather(this.config.location, this.config.weatherApiKey)
        : [];

      let solarGain = 0;
      if (this.config.tank.solar) {
        solarGain = estimateSolarGainPerHour(weather, now.getMonth());
      }
      const tankTemp = estimateTankTemp(this.state, weather, now, this.config.tank, this.config.timezone, this.config.usage, hourly);

      // Persist estimate
      this.state.lastEstimatedTemp = tankTemp;
      this.state.lastEstimatedAt = now.toISOString();
      this.persistState();

      const prompt = buildPrompt(now, weather, tankTemp, solarGain, this.state, this.config, this.config.timezone);

      const raw = await callAI(
        prompt, 30,
        this.config.xaiApiKey, this.config.geminiApiKey,
        this.config.aiTemperature, this.log,
      );

      this.log.debug(`AI RAW RESPONSE: ${raw}`); // #13: debug not info

      const { minutes, report } = parseAIResponse(raw, this.config.maxDurationMinutes);

      this.log.info(`DECISION: ${minutes} mins | tank ~${Math.round(tankTemp)}°C | ${weather.raw} | trigger: ${trigger}`);

      if (minutes > 0 && !this.config.dryRun) {
        await this.startBoilerCycle(minutes, trigger, weather, report);
      } else if (minutes > 0 && this.config.dryRun) {
        this.log.info(`[DRY RUN] Would heat for ${minutes} min — ${report}`);
      }

      return report;
    } catch (err) {
      this.log.error(`Decision cycle failed: ${(err as Error).message}`);
      return `error: ${(err as Error).message}`;
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
    this.state.boilerOn = true;
    this.state.runStartedAt = startTime.toISOString();
    this.state.runDurationMin = capped;
    this.persistState();

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

    // Persistent retry — don't give up easily (#3)
    const offSuccess = await this.sendBoilerOffWithRetries(5, 10000);

    this.boilerRunning = false;
    this.accessory?.updateState(false);

    if (!offSuccess) {
      this.log.error('CRITICAL: all OFF attempts failed — boiler may still be physically ON');
      // Don't clear watchdog — let it try stopBoiler as last resort
      // Also schedule aggressive retries
      let extraAttempts = 0;
      const retryInterval = setInterval(async () => {
        extraAttempts++;
        try {
          await this.sendBoilerOff();
          this.log.warn(`RECOVERY: OFF succeeded on extra attempt ${extraAttempts}`);
          clearInterval(retryInterval);
        } catch {
          this.log.error(`RECOVERY: extra OFF attempt ${extraAttempts} failed`);
          if (extraAttempts >= 10) clearInterval(retryInterval);
        }
      }, 60000);
    } else {
      if (this.watchdogTimer) clearTimeout(this.watchdogTimer);
    }

    // Update state
    this.state.boilerOn = !offSuccess; // Only mark off if OFF succeeded
    this.state.runStartedAt = undefined;
    this.state.runDurationMin = undefined;

    appendHistory(this.state, {
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
    if (this.state.lastEstimatedTemp > 0) {
      this.state.lastEstimatedTemp += minutes * rate;
    } else {
      const month = startTime.getMonth() + 1;
      const baseTemp = (month >= 5 && month <= 9) ? 25 : 20;
      this.state.lastEstimatedTemp = baseTemp + minutes * rate;
    }
    if (this.state.lastEstimatedTemp > 70) this.state.lastEstimatedTemp = 70;
    this.state.lastEstimatedAt = new Date().toISOString();

    this.persistState();
    this.log.info(`BOILER OFF: finished ${minutes} min cycle (trigger: ${trigger})`);
  }

  async stopBoiler(): Promise<void> {
    if (this.cycleTimer) clearTimeout(this.cycleTimer);

    const offSuccess = await this.sendBoilerOffWithRetries(3, 5000);

    this.boilerRunning = false;
    this.accessory?.updateState(false);
    if (this.watchdogTimer) clearTimeout(this.watchdogTimer);

    this.state.boilerOn = !offSuccess;
    this.state.runStartedAt = undefined;
    this.state.runDurationMin = undefined;
    this.persistState();

    this.log.info(`EMERGENCY STOP: boiler forced OFF ${offSuccess ? '(confirmed)' : '(WARNING: OFF command failed)'}`);
  }

  private recoverFromCrash(): void {
    if (this.state.boilerOn) {
      this.log.warn('RECOVERY: boiler was ON from previous crash — sending OFF');
      this.sendBoilerOffWithRetries(5, 5000).then(success => {
        if (!success) {
          this.log.error('RECOVERY: all OFF attempts failed — boiler may still be ON');
        }
        this.state.boilerOn = !success;
        this.state.runStartedAt = undefined;
        this.state.runDurationMin = undefined;
        this.persistState();
      });
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
      this.log.info(`SCHEDULER: completed — ${report}`);
      this.scheduleNext();
    }, sleepMs);
  }
}
