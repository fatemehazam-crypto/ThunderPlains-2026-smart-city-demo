# Deploy the phone relay (optional)

By default `npm start` runs the relay on your laptop, so phones join over your local Wi-Fi. That's enough to try everything, with two limits:

- the page is plain HTTP, so phones can **tap** but can't share **motion** (browsers only allow motion sensors on HTTPS pages)
- phones must be on the same network as the laptop, and some networks (conferences, hotels, eduroam) block that

Deploying the relay fixes both: it gets an HTTPS address that any phone on any network can open. Your laptop's bridge connects **out** to it, so nothing on your laptop is exposed. These steps use [Render](https://render.com)'s free plan; any Node host with HTTPS and WebSockets works.

## 1. Create the service

1. Fork this repo to your GitHub account.
2. In Render: **New → Blueprint**, pick your fork. Render reads `render.yaml` and proposes a web service called `smartcity-phone-relay`. Click **Apply**.
3. Wait for the first deploy to finish, then open `https://<your-service>.onrender.com/healthz`. You should see `{"ok":true,...}`.

Render generates a random `STAGE_TOKEN` for you. It's the secret that lets only *your* bridge connect to the relay. Render also tells the relay its own HTTPS address, so the QR code is right automatically.

## 2. Point the launcher at it

1. In Render, open the service → **Environment** and copy the `STAGE_TOKEN` value.
2. Create `stage/stage.config.json` (it's git-ignored, so the token stays off GitHub):

```json
{
  "relay": "remote",
  "relayUrl": "https://<your-service>.onrender.com",
  "stageToken": "<paste STAGE_TOKEN here>"
}
```

3. `npm start`. The bridge line should say `relay connected`, and the Stage tab's QR code now points at your HTTPS address.

## Good to know

- **Free services sleep after about 15 minutes idle** and take up to a minute to wake. `npm start` pings the relay as it starts, but before a live demo open `/healthz` yourself a few minutes early.
- **Run one instance.** The relay keeps its state in memory.
- **Phones only go live while your bridge is connected.** If your laptop drops off, phones show "paused" and resume when it's back.
- **Never put the token on a slide** or commit it. If it leaks, change it in Render (Environment → edit), redeploy, and update `stage.config.json`.
