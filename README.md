# Homebridge Boiler AI

AI-powered hot water controller for Homebridge. Uses AI to decide when to run your electric boiler, optimizing for minimal electricity by leveraging solar heating on sunny days.

Works with [Switcher](#switcher), [Shelly](#shelly), [Tasmota](#tasmota), and [any HTTP-controllable plug](#other-smart-plugs).

## Setup (5 minutes)

Install the plugin from the Homebridge UI: search for **homebridge-boiler-ai** and click install.

Then configure in the plugin settings (or paste into `config.json`):

<details>
<summary><b>Full config example — Switcher</b></summary>

```json
{
  "platform": "BoilerAI",
  "name": "Boiler AI",
  "location": "Tel Aviv",
  "timezone": "Asia/Jerusalem",
  "geminiApiKey": "YOUR_GEMINI_API_KEY",
  "tank": {
    "liters": 120,
    "heaterKw": 2.5,
    "solar": true
  },
  "switcher": {
    "deviceId": "Switcher_Touch_386C"
  },
  "usage": [
    { "time": "07:00", "label": "Morning shower", "liters": 60, "temp": 45 },
    { "time": "20:00", "label": "Evening shower", "liters": 100, "temp": 50 }
  ]
}
```
</details>

<details>
<summary><b>Full config example — Shelly / HTTP plug</b></summary>

```json
{
  "platform": "BoilerAI",
  "name": "Boiler AI",
  "location": "Tel Aviv",
  "timezone": "Asia/Jerusalem",
  "geminiApiKey": "YOUR_GEMINI_API_KEY",
  "tank": {
    "liters": 120,
    "heaterKw": 2.5,
    "solar": true
  },
  "boilerPlug": {
    "onUrl": "http://192.168.1.50/relay/0?turn=on",
    "offUrl": "http://192.168.1.50/relay/0?turn=off"
  },
  "usage": [
    { "time": "07:00", "label": "Morning shower", "liters": 60, "temp": 45 },
    { "time": "20:00", "label": "Evening shower", "liters": 100, "temp": 50 }
  ]
}
```
</details>

---

### 1. AI API Key

Get a free API key from [Google AI Studio](https://aistudio.google.com/apikey) — sign in, click "Create API Key", and paste it into the **Gemini API Key** field. The free tier is more than enough (the plugin makes a few calls per day).

Alternatively, you can use [xAI Grok](https://console.x.ai/) (paid but faster).

### 2. Location

Enter your city name in the **Location** field. To verify it works, run `curl wttr.in/YourCity` — if it shows the right weather, use that name.

Enter your timezone in the **Timezone** field. To find it, run `timedatectl | grep "Time zone"`.

### 3. Smart Plug

Tell the plugin how to turn your boiler on and off. Pick your plug type:

#### Switcher

Native support — the plugin finds and controls the Switcher directly on your local network. No URLs needed, no extra plugins.

Enter your device name (as it appears in the Switcher app), IP address, or device ID — any of these work:

```json
"switcher": {
  "deviceId": "Switcher_Touch_386C"
}
```

If you get auth errors in the logs, your model may need a token — get it from https://switcher.co.il/GetKey/ and add `"token": "your-token"`.

#### Shelly

```json
"boilerPlug": {
  "onUrl": "http://192.168.1.50/relay/0?turn=on",
  "offUrl": "http://192.168.1.50/relay/0?turn=off"
}
```

For Gen2+ (Plus/Pro series):
```json
"boilerPlug": {
  "onUrl": "http://192.168.1.50/rpc/Switch.Set?id=0&on=true",
  "offUrl": "http://192.168.1.50/rpc/Switch.Set?id=0&on=false"
}
```

#### Tasmota

```json
"boilerPlug": {
  "onUrl": "http://192.168.1.51/cm?cmnd=Power%20On",
  "offUrl": "http://192.168.1.51/cm?cmnd=Power%20Off"
}
```

#### Other smart plugs

Any plug with an HTTP on/off URL works. For plugs that need POST requests or auth headers:

```json
"boilerPlug": {
  "onUrl": "http://192.168.1.53/api/switch/on",
  "offUrl": "http://192.168.1.53/api/switch/off",
  "method": "POST",
  "headers": "{\"Authorization\": \"Bearer TOKEN\", \"Content-Type\": \"application/json\"}",
  "body": "{\"device\": \"boiler\"}"
}
```

> **Note:** Use either `switcher` or `boilerPlug` — not both.

### 4. Hot Water Schedule

Add the times your household needs hot water:

```json
"usage": [
  { "time": "07:00", "label": "Morning shower", "liters": 60, "temp": 45 },
  { "time": "18:30", "label": "Kid bath", "liters": 50, "temp": 45 },
  { "time": "22:00", "label": "Evening shower", "liters": 100, "temp": 50 }
]
```

The plugin checks automatically ~1 hour before each event and only heats if needed. On sunny days, the sun does the work and the electric heater stays off.

### Tank

Enter your tank capacity (**liters**) and heater power (**kW**) — found on the tank's nameplate. The heating rate is calculated automatically.

```json
"tank": {
  "liters": 120,
  "heaterKw": 2.5,
  "solar": true
}
```

Set `"solar": false` if your tank is electric-only (no rooftop solar panel).

## How it works

**The plugin is fully autonomous.** Once configured, it runs on its own. Before each time you need hot water, it:

1. Fetches weather and sunrise/sunset for your location
2. Estimates the tank temperature from heating history and solar gain
3. Asks the AI whether heating is needed and for how long
4. Turns the boiler on/off via your smart plug

This runs in the background as long as Homebridge is running — no interaction needed.

### The HomeKit switch

The boiler appears as a switch in the Home app, but it does **not** enable/disable the system. Think of it as a button:

- **Tap ON** = "check now" — manually triggers one AI decision. The switch turns itself back off afterward.
- **Tap OFF** = emergency stop — immediately turns off the boiler if it's heating.

The automatic schedule runs regardless. You never need to touch the switch — it's there for manual overrides only.

## Safety

- **Max duration cap** — no single cycle exceeds 90 minutes (configurable)
- **Watchdog timer** — force-stops 5 minutes after max, no matter what
- **Crash recovery** — sends OFF on Homebridge restart if boiler was left on
- **Retry logic** — 3 attempts for every on/off command, with emergency double-off on failure
