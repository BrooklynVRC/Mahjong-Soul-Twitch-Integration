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

## Calibration: done once, for everyone

The apps ship with a **built-in calibration**, and keep it up to date online. Most people never calibrate anything. Calibration is shared by the Twitch and Lovense apps (in `%APPDATA%MahjongSoulScreenReader`), so teaching in either one sets up both.

**How it reads the game.** The core is the **four point totals** in the centre panel, read from a full-resolution zoom of that area. Score changes give almost everything, and they don't care about skins or riichi effects:

| What changes | What it means |
|---|---|
| One player −1,000, nothing else | that player declared **riichi** |
| One player gains, one pays | **ron** (my ron / an opponent's / **I dealt in**) |
| One player gains, everyone pays | **tsumo** |
| Two or more gain small amounts | **draw** (noten payments) |
| Everyone on the starting score | **game start** |
| Score panel gone for a while | **game over**, final place = last placement |

Your **live placement** and the **lead changes** come from the same numbers. Banner templates are optional extras for things scores can't show: yakuman, calls, round start, the game mode name, and instant results screens.

**It works the same at any window size.** The reader crops the title bar and borders, uses the 16:9 game area, and normalizes every box. Windowed, borderless and fullscreen at any resolution all look alike to it.

### Calibrating (the one-time setup)

1. Open **Screen reader & calibration**. The **Setup** card shows each step, with a **Do it** button for the next one.
2. Play a match. Whenever something useful is on screen (the scores, a banner), press **F8**. It saves the last 5 seconds, even while you're in the game.
3. Back in the app, click an F8 bookmark. Switch the picture to **Zoom (scores)**, then for each seat box the score, type the number shown, and click **Teach**. Start with your own score. The other seats are drawn sideways or upside down; the rotation is detected automatically.
4. Teach a few different scores until all digits 0–9 are known; the Setup card lists what's missing. After that, the reader keeps learning by itself from clear readings.
5. Optional: box the mode name shown when a match loads, save it as *Game mode* and name it (e.g. "Gold Room · East"). Add any extra banners from the chips.

### Sharing your calibration with everyone

From the repo, with the apps closed:

```powershell
npm run calibration:publish
```

This writes `calibration/default-pack.json` in both repos. Commit and push, and every app with *Get calibration updates online* (on by default) picks it up. Each new release bundles it too. **Export calibration** and **Import** on the screen reader page do the same by hand.

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
