## Download

**MahjongSoul-Twitch.exe**: one file, nothing else to install. Double-click it and the app opens in its own window.

- Windows may show "Windows protected your PC" because the app isn't code-signed. Click **More info → Run anyway**.
- It reads Mahjong Soul (Steam client) **from the screen, like a screen share**. It never touches the game's files or process, and it works while you're tabbed out (just don't minimize the game).

### First run
1. Open **Screen reader & calibration** and teach it the banners (RIICHI / RON / TSUMO / results) and the four score boxes.
2. Connect Twitch (needs a free app at dev.twitch.tv; the redirect URL is shown in the app).
3. Optional: Discord Rich Presence (paste your Discord Application ID) and/or a channel webhook.
4. OBS: add a Browser Source for `http://localhost:7701/overlay`.

Settings live in `%APPDATA%\MahjongSoulTwitch`; screen reader calibration in `%APPDATA%\MahjongSoulScreenReader`. Full guide: [README](https://github.com/BrooklynVRC/Mahjong-Soul-Twitch-Integration#readme).
