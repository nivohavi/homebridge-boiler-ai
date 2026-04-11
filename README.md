# Homebridge Boiler AI

A [Homebridge](https://homebridge.io) plugin that uses AI (Gemini or Grok) to control a solar hot water tank's electric backup heater, optimizing for minimal electricity usage.

## Features

- AI-powered heating decisions based on weather, solar gain, and your hot water schedule
- Works with any HTTP-controllable smart plug (Shelly, Tasmota, Home Assistant switches, etc.)
- Sunrise/sunset fetched automatically for your location
- Heating rate calculated from your tank specs
- Solar gain model disabled for electric-only tanks
- Crash recovery — sends OFF if Homebridge restarts mid-cycle
- Configurable entirely through the Homebridge UI

## Installation

### Via Homebridge UI (recommended)

Search for `homebridge-boiler-ai` in the Homebridge plugin search and click install.

### Via CLI

```bash
npm install -g homebridge-boiler-ai
```

## Configuration

Configure through the Homebridge UI (Settings → Boiler AI) or add to `config.json`:

```json
{
  "platforms": [
    {
      "platform": "BoilerAI",
      "name": "Boiler AI",
      "location": "Tel Aviv",
      "timezone": "Asia/Jerusalem",
      "geminiApiKey": "your-gemini-api-key",
      "tank": {
        "liters": 120,
        "heaterKw": 2.5,
        "solar": true
      },
      "boilerPlug": {
        "onUrl": "http://shelly-ip/relay/0?turn=on",
        "offUrl": "http://shelly-ip/relay/0?turn=off"
      },
      "usage": [
        { "time": "07:00", "label": "Morning shower", "liters": 60, "temp": 45 },
        { "time": "20:00", "label": "Evening shower", "liters": 100, "temp": 50 }
      ],
      "maxDurationMinutes": 90
    }
  ]
}
```

### Required settings

| Setting | Description |
|---------|-------------|
| `location` | City name for weather (test: `curl wttr.in/YourCity`) |
| `timezone` | IANA timezone (find: `timedatectl \| grep "Time zone"`) |
| `geminiApiKey` or `xaiApiKey` | AI API key |
| `tank.liters` | Tank capacity |
| `tank.heaterKw` | Heater power |
| `boilerPlug.onUrl` | URL to turn boiler on |
| `boilerPlug.offUrl` | URL to turn boiler off |
| `usage` | When you need hot water |

### Optional settings

| Setting | Default | Description |
|---------|---------|-------------|
| `tank.solar` | `true` | Set `false` for electric-only tanks |
| `boilerPlug.method` | `GET` | HTTP method (`GET` or `POST`) |
| `boilerPlug.headers` | — | JSON string of HTTP headers |
| `boilerPlug.body` | — | Request body for POST |
| `maxDurationMinutes` | `90` | Safety cap per cycle |
| `aiTemperature` | `0.3` | AI creativity (lower = conservative) |

### Smart plug examples

Replace the IP address with your plug's actual IP.

**Shelly (Plus Plug S, Plug S, 1PM, etc.):**
```json
{
  "onUrl": "http://192.168.1.50/relay/0?turn=on",
  "offUrl": "http://192.168.1.50/relay/0?turn=off"
}
```

**Shelly Gen2+ (Plus/Pro series with switch API):**
```json
{
  "onUrl": "http://192.168.1.50/rpc/Switch.Set?id=0&on=true",
  "offUrl": "http://192.168.1.50/rpc/Switch.Set?id=0&on=false"
}
```

**Tasmota:**
```json
{
  "onUrl": "http://192.168.1.51/cm?cmnd=Power%20On",
  "offUrl": "http://192.168.1.51/cm?cmnd=Power%20Off"
}
```

**Sonoff eWeLink (via LAN mode):**
```json
{
  "onUrl": "http://192.168.1.52:8081/zeroconf/switch",
  "offUrl": "http://192.168.1.52:8081/zeroconf/switch",
  "method": "POST",
  "headers": "{\"Content-Type\": \"application/json\"}",
  "body": "{\"deviceid\": \"YOUR_DEVICE_ID\", \"data\": {\"switch\": \"on\"}}"
}
```

**TP-Link Kasa (via homebridge-http-webhooks bridge):**
```json
{
  "onUrl": "http://localhost:51828/?accessoryId=boiler&state=true",
  "offUrl": "http://localhost:51828/?accessoryId=boiler&state=false"
}
```

**Switcher (Israeli boiler plug) — native support, no extra plugins:**

Switcher is supported natively via the `switcher` config. No HTTP URLs needed — the plugin talks directly to the Switcher on your local network. Just add the `switcher` section instead of `boilerPlug`:

```json
{
  "switcher": {
    "deviceId": "aabbcc",
    "deviceIp": "192.168.1.50"
  }
}
```

To find your device ID and IP, check the Switcher app or use [aioswitcher](https://github.com/TomerFi/aioswitcher) discovery.

**Any plug with POST + auth:**
```json
{
  "onUrl": "http://192.168.1.53/api/switch/on",
  "offUrl": "http://192.168.1.53/api/switch/off",
  "method": "POST",
  "headers": "{\"Authorization\": \"Bearer YOUR_TOKEN\", \"Content-Type\": \"application/json\"}",
  "body": "{\"device\": \"boiler\"}"
}
```

## How it works

**The plugin is fully autonomous.** Once configured, it runs on its own — no interaction needed. At scheduled times (automatically derived from your usage, ~1 hour before each event), it:

1. Fetches weather and sunrise/sunset for your location
2. Estimates tank temperature from heating history and solar gain
3. Asks the AI whether to heat and for how long
4. Turns the smart plug on/off via HTTP

This happens whether you open the Home app or not. The scheduler runs in the background as long as Homebridge is running.

### The HomeKit switch

The boiler appears as a switch in the Home app, but it does **not** enable/disable the system. Think of it as a button, not a light switch:

- **Tap ON** = manually triggers one AI decision cycle ("check now"). The AI decides whether to heat. The switch turns itself back off afterward.
- **Tap OFF** = emergency stop. Only relevant if the boiler is actively heating mid-cycle.

The automatic schedule runs regardless of the switch state. You never need to touch it — it's there for manual overrides only (e.g. unexpected guests, want hot water sooner).

## AI Providers

| Provider | Model | Notes |
|----------|-------|-------|
| Google Gemini | gemini-2.5-flash-lite | Free tier available |
| xAI Grok | grok-3-mini-fast | Preferred when both keys set |

## Safety

- Maximum heating duration cap (default 90 min)
- Watchdog timer force-stops 5 minutes after max
- Crash recovery on restart
- Webhook retries with emergency double-off
