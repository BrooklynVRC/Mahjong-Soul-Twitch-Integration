# Mahjong Soul × Twitch

Use your live Mahjong Soul games on stream:

- **Chat announcements**: riichi, tsumo/ron (with han, fu and yaku), deal-ins, yakuman, draws and final placement. Every message has its own template and on/off switch.
- **OBS overlay**: round, honba, riichi sticks, all four scores with riichi badges, a pop-up event feed, and session stats. You can theme all of it.
- **Chat commands**: `!stats`, `!score`, `!last`, mod-only `!msreset`, plus as many custom commands as you want.
- **Auto predictions**: opens "Will I get 1st?" (or a 1st–4th pick) when a game starts and resolves it from the result. Needs Affiliate or Partner.
- **Event forwarding**: bits, subs, gifts, follows, raids, channel point redeems and chat commands are shared on `ws://localhost:7701/events` so other apps can react. The companion [Mahjong Soul Lovense Integration](https://github.com/BrooklynVRC/Mahjong-Soul-Lovense-Integration) app uses this.

Everything is set from a local settings page at <http://localhost:7701>.

## Quick start (no coding)

1. Install [Tampermonkey](https://www.tampermonkey.net/) in your browser. On Chrome/Edge, open the extension's details and turn on **Allow User Scripts**.
2. Download **MahjongSoul-Twitch.exe** from the [latest release](https://github.com/BrooklynVRC/Mahjong-Soul-Twitch-Integration/releases/latest) and double-click it.
   Windows may warn that the app isn't signed. Click **More info → Run anyway**.
3. The settings page opens in your browser. Click **Install userscript**, then follow the Twitch app steps in step 3 of [Setup](#setup) and click **Connect Twitch**.
4. In OBS, add a Browser Source for `http://localhost:7701/overlay`.
5. Keep the app's window open while you stream, and play Mahjong Soul in the same browser.

Your settings are stored in `%APPDATA%\MahjongSoulTwitch`. To update, download the new `.exe` and replace the old one; your settings are kept.

## How it works

```
Mahjong Soul (browser) ──userscript──▶ this app (localhost:7701) ──▶ Twitch chat / predictions
                                                                 ├─▶ OBS overlay
Twitch EventSub + chat ─────────────────────────────────────────┴─▶ /events  (e.g. Lovense app)
```

The userscript **only reads** the game's WebSocket traffic in your own browser tab. It never sends anything to the game, never automates play, and never shows hidden information. It decodes a few public events (riichi, wins, draws, results) and forwards them to `127.0.0.1`.

> ⚠️ Any client-side script is technically outside Yostar's terms of service. This one is passive and read-only, but use it at your own risk.

## Setup

1. **Start the app.** Either run the `.exe` from the latest release (see Quick start), or install Node.js 20+ and run it from source:
   ```powershell
   npm install
   npm start
   ```
2. **Install the userscript.** Install [Tampermonkey](https://www.tampermonkey.net/) or Violentmonkey, then create a new script and paste in [`userscript/mahjong-soul-bridge.user.js`](userscript/mahjong-soul-bridge.user.js).
   - Chrome/Edge: open the extension's details page and turn on **Allow User Scripts**.
   - If the browser asks to let the game access devices on your local network, allow it. That's how the script reaches this app.
   - Install the script **only once**. It sends to both this app and the Lovense app (ports 7701 and 7702).
3. **Create a Twitch application** at <https://dev.twitch.tv/console/apps>:
   - OAuth Redirect URL: `http://localhost:7701/auth/callback`
   - Category: Chat Bot
   - Paste the Client ID and a new Client Secret into the settings page, then **Save** and click **Connect Twitch**.
4. **OBS**: add a *Browser Source* with URL `http://localhost:7701/overlay` (about 600×400).
   To place widgets separately, add more sources using `?only=scores`, `?only=feed` or `?only=session`.
5. Open Mahjong Soul in the browser. The settings page should show **Game userscript: connected**.

Use the **Test without playing** buttons to try every announcement and overlay pop-up without starting a game.

## Template placeholders

| Placeholder | Meaning |
|---|---|
| `{player}` / `{winner}` | Player who riichi'd/called/won |
| `{from}` | Player who dealt in (ron) |
| `{han}` `{fu}` `{points}` `{yaku}` | Hand value; `{points}` is the winner's score change |
| `{lost}` | Points you lost when dealing in |
| `{riichiType}` `{call}` | "riichi"/"DOUBLE RIICHI", "chi"/"pon"/"kan"… |
| `{reason}` `{tenpai}` | Draw reason and tenpai players |
| `{place}` `{score}` | Your final placement and score |
| `{round}` `{scores}` `{opponents}` | Current round, all scores, opponent names |
| `{games}` `{avgPlace}` `{first}`…`{fourth}` `{sessionSummary}` `{lastPlace}` `{lastScore}` | Session stats |

## Event feed for other apps

Connect a WebSocket client to `ws://localhost:7701/events` and you'll receive JSON such as:

```json
{ "source": "twitch", "type": "bits", "user": "SomeViewer", "amount": 100, "ts": 1700000000000 }
```

`type` is one of `chat`, `bits`, `sub`, `resub`, `gift`, `follow`, `raid`, `redeem` (with `rewardTitle`, `message`). Chat is forwarded only for messages starting with `!`, unless you change that in settings.

## Files

- `config.json`: your settings (created on first save, git-ignored)
- `tokens.json`: Twitch OAuth tokens (git-ignored, **keep private**)
- `session.json`: session stats

## Troubleshooting

- **No game events:** in the game tab's console run `localStorage.msbDebug = '1'`, then reload. The script will log each event it sees. If a game update renames messages, the decoder schemas at the top of the userscript may need updating.
- **"forbidden origin":** the settings API only accepts requests from `localhost:7701`.
- **Predictions fail:** the account must be Affiliate or Partner, and you must have authorized with the `channel:manage:predictions` scope. Reconnect Twitch after updating the app.

## Development

```powershell
npm run dev        # restart on change
npm run typecheck
npm test           # userscript decoder tests
npm run package    # build release/*.exe (standalone, no Node needed)
```

**Making a release:** bump `version` in package.json, commit, then push a tag such as `v1.0.1`. GitHub Actions builds the .exe and publishes the release automatically.

MIT licensed.
