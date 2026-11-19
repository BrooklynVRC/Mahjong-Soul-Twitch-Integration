# Mahjong Soul × Twitch

A Windows app that **reads your Mahjong Soul game from the screen** (Steam client) and drives your stream:

- **Twitch chat messages** for riichi, ron, tsumo, deal-ins, yakuman, draws, lead changes and your final placement. Each has its own text and on/off switch.
- **OBS overlay**: game mode, live placement, time in game, session stats and a pop-up event feed.
- **Chat commands**: `!place` (in game? which mode, what place, how long), `!stats`, `!last`, mod-only `!msreset`, plus your own.
- **Auto predictions** ("Will I get 1st?" or a 1st–4th pick), opened at game start and resolved from the result. Needs Affiliate or Partner.
- **Discord Rich Presence**: your profile shows *Playing Mahjong Soul*, with the mode, live place and an elapsed timer, or "In the lobby" with your session stats.
- **Discord channel messages** through a webhook (optional).
- **Viewer events for the Lovense app**: bits, subs, gifts, follows, raids, redeems and chat commands, shared locally.

## Read-only: it never touches the game

The screen reader gets the game's picture the same way **OBS Window Capture and Discord screen share** do, through Windows Graphics Capture. It never opens the game's process, injects code, changes files or sends the game input. It keeps working while the game is behind other windows or you've tabbed out, but **not while it's minimized**, so run the game windowed or borderless. You can also have it read an OBS source instead.

## Quick start

1. Download **MahjongSoul-Twitch.exe** from the [latest release](https://github.com/BrooklynVRC/Mahjong-Soul-Twitch-Integration/releases/latest) and double-click it. It opens in its own window; there's nothing else to install.
   Windows may warn that the app isn't signed. Click **More info → Run anyway**.
2. Start Mahjong Soul, then open **Screen reader & calibration** in the app and teach it (see below).
3. **Twitch**: create an application at <https://dev.twitch.tv/console/apps> with the OAuth redirect URL `http://localhost:7701/auth/callback` (category *Chat Bot*). Paste the Client ID and a new Client Secret into settings, **Save**, then **Connect Twitch**.
4. **OBS**: add a *Browser Source* for `http://localhost:7701/overlay` (about 600×300). To place the widgets as separate sources, add `?only=status`, `?only=feed` or `?only=session` to the URL.
5. **Discord** (optional): see below.

Closing the window quits the app.

## Calibrating the screen reader

The reader learns from your own screen, so it works with any resolution, language or skin. Everything you teach is shared with the Lovense app.

**Banners** (tab *2a*):
1. When a banner appears (RIICHI, RON, TSUMO, the draw banner, the final results), click **Freeze**. It keeps the last 20 seconds, so you can click it afterwards.
2. Slide to the clearest frame, drag a box tightly around the banner's word, pick the event and click **Save banner template**.
3. Check the live bar crosses the yellow threshold mark when the banner shows, and use **Scan frozen frames** to tune it.

**Who did it.** You have two ways:
- **Easiest:** teach one *Riichi / Ron / Tsumo (anyone)* banner each, plus the score boxes. The reader works out who it was from the score change: a riichi costs that player exactly 1,000, and a win shows who gained and who paid. So it tells *my ron* from *an opponent's ron*, and spots when *I* dealt in.
- **Per side:** teach separate banners for each side of the table (*My riichi* at the bottom, *Opponent riichi* on the others, and so on).

**Score boxes** (tab *2b*): freeze any moment with the centre score panel visible. Drag a tight box around one player's score, pick whose it is, type the number shown and click **Teach**. Do all four seats; scores with different digits teach more of them. After that, the app reads all four scores live. From them it gets your **current placement**, the **lead changes** and **who riichi'd or won**. Being in a game, and for how long, comes from the scores being on screen.

**Game mode**: box the room or mode name that shows when a match loads. Save it as *Game mode* and **name it after the mode**, e.g. "Gold Room · East". Chat and Discord show that name.

The screen reader page also has detection snapshots (see exactly what fired), template export and import, a pause switch, and tuning settings: frames to confirm, re-arm margin, position tolerance and digit confidence.

## Discord

- **Rich Presence**:
  1. Create an application at <https://discord.com/developers/applications>. Its name is what shows after "Playing", e.g. name it *Mahjong Soul*.
  2. Copy its **Application ID** into *Discord → Rich Presence* and turn it on.
  3. Optionally upload an image under *Rich Presence → Art Assets* and type its name in *Image*.
  4. Discord must be running on the same PC.

  Both lines of text can be edited. Placeholders: `{mode}` `{place}` `{placeText}` `{elapsed}` `{sessionSummary}` `{games}` `{avgPlace}` and more.
- **Channel messages**: Channel settings → Integrations → Webhooks → *New Webhook* → *Copy Webhook URL*. Paste it into *Discord → Channel messages* and pick which events to post. They use the same text as the chat messages. **Test Discord webhook** sends a test message.

## Placeholders

`{mode}` `{modeText}` `{place}` `{placeText}` `{elapsed}` `{statusText}` `{games}` `{avgPlace}` `{first}` `{second}` `{third}` `{fourth}` `{lastPlace}` `{sessionSummary}`

## Viewer events for other apps

Connect to `ws://localhost:7701/events` to receive JSON like `{ "source": "twitch", "type": "bits", "user": "SomeViewer", "amount": 100 }`. The `type` is one of `chat`, `bits`, `sub`, `resub`, `gift`, `follow`, `raid` or `redeem`.

## Files

- `%APPDATA%\MahjongSoulTwitch`: `config.json`, `tokens.json` (Twitch login, **keep private**), `session.json`, `app.log`
- `%APPDATA%\MahjongSoulScreenReader`: `templates.json` and `scores.json`, shared with the Lovense app

## Building from source

Needs Node 22+ and the .NET 8 SDK.

```powershell
npm install
npm run build:host   # desktop window + capture helper (C#)
npm start            # runs the server and opens it in your browser
npm test
npm run package      # release\MahjongSoul-Twitch.exe
```

**Making a release:** bump `version` in package.json, commit, then push a tag like `v2.0.1`. GitHub Actions builds the app and publishes the release.

MIT licensed. Not affiliated with Yostar or Mahjong Soul.
