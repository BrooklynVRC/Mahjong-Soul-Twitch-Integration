# Mahjong Soul Screen Reader

For players on the **Steam / desktop client**, where the browser userscript can't run. It watches the game's picture and sends events (riichi, ron, tsumo, deal-in, draw, final placement…) to the Twitch app and the Lovense app.

**It's read-only and never touches the game.** It doesn't modify the game's files, inject into its process, or send it input or messages. It only looks at the picture, in one of two ways:

- **Game window** (default): uses Windows Graphics Capture, the same system that OBS *Window Capture* and Discord screen share use. It keeps working while the game is behind other windows or you've tabbed away. It **can't see a minimized window**, so run the game windowed or borderless rather than exclusive fullscreen.
- **OBS source**: asks OBS for a still frame of the source you already show on stream, through OBS's built-in WebSocket server.

The same program ships in both the Twitch and Lovense repos. Run it **once**; it sends to both apps.

## Setup

1. Download **MahjongSoul-ScreenReader.exe** from the latest release and double-click it. The settings page opens at <http://localhost:7703>.
2. Start Mahjong Soul. *Picture* should say **capturing…** and the live view should show the game.
3. Teach it the banners (below).
4. Start the Twitch app and/or the Lovense app. *Sending to* turns green for each one that's running.

## Teaching it banners

The screen reader learns from your own screen, so it works with any language, resolution or skin.

1. Play, or watch a replay. When a banner appears (RIICHI, RON, TSUMO, the draw banner, the final results…), click **Freeze last 10 s**.
2. Move the slider to the frame where the banner is clearest, then **drag a box tightly around the banner's word**.
3. Choose which event it is (e.g. *My riichi*) and click **Save template**.
4. Watch the template's bar in **Templates**. It jumps past the yellow threshold mark when that banner shows up.

Tips:
- **Which side:** "My" events use the banner on **your side** (bottom). Banners for opponents show up on their sides, so teach one template per side and give them all the same event, e.g. *Opponent riichi*.
- **Dealing in:** the banner alone doesn't show who paid, so pick something on the score screen that shows *you* lost points.
- **Placement:** for 1st–4th, cut the part of the final results screen that marks your placement.
- **Wrong or missed detections:** raise the threshold if it fires by mistake, lower it if it misses, and use the cooldown to stop repeats.
- **Analysis width:** if you change it, re-teach your templates.

## Tools for tuning

- **Setup checklist and hints:** the top of the page shows what's working and what to do next (e.g. the game is minimized, or there are no templates yet).
- **Detection snapshots:** every detection keeps the exact picture that triggered it. Click it in *Detections* to see why it fired, and teach a new template straight from it.
- **Scan frozen frames:** after freezing, this shows each template's best and lowest score across the frozen frames, so you can choose a threshold that fires on the banner and nowhere else.
- **Pause detection:** stops sending events (e.g. between streams) while the picture keeps updating.
- **Export / Import:** save your templates to a file, move them to another PC, or share them with someone who uses the same resolution and language.
- **Frames to confirm / Re-arm margin** (settings): require a banner to match several checks in a row, and to fade before it can fire again. This cuts double-fires and flicker.

## What it can't know

The screen reader only knows *which* banner appeared. It doesn't know han, fu, yaku, points or player names. The Twitch app uses its **"Text (screen reader)"** messages for these events, e.g. "I won by TSUMO!". For full detail, play the browser version with the userscript instead.

## Settings

| Setting | What it does |
|---|---|
| Picture source | Game window (Windows Graphics Capture) or an OBS source |
| Game process name | `Jantama_MahjongSoul` for Steam; your browser's process (e.g. `chrome`) to read the browser version instead |
| OBS | Enable OBS → Tools → *WebSocket Server Settings*, copy the password, and enter the source's exact name (*List OBS sources* helps) |
| Checks per second | How often it looks (4 is plenty) |
| Position tolerance | How far a banner may move from where you taught it |
| Send events to | The Twitch app (`7701`) and Lovense app (`7702`) |

Settings and templates are stored in `%APPDATA%\MahjongSoulScreenReader`.

## Building from source

```powershell
npm install
npm run build:helper   # needs the .NET 8 SDK; builds capture-helper\ (C#, Windows Graphics Capture)
npm start
npm test
npm run package        # release\MahjongSoul-ScreenReader.exe
```
