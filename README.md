# ♠ Guandan Counter ♥

**Your scorekeeper for game night.** Track both teams' levels from 2 all the way to A, fix any mistake with one tap, and find out once and for all who the best partnership at the table is.

Shuffle up and have fun! 🃏

---

## What it does

- **Big playing-card scoreboard.** Each team's level shows as a card you can read from across the table. It flips over every time a team climbs.
- **Two taps per hand.** Tap the team that won, then tap where the partner finished (1-2, 1-3 or 1-4). The app works out the new level.
- **Knows the rules.** Shows whose level is being played and which heart is wild, and handles the "you must win on A" rule. You can also turn on house rules like "1-4 counts on A" or "back to 2 after 3 missed tries".
- **Mistakes are no big deal.** Undo the last hand, tap any earlier hand to edit or delete it, and every level after it fixes itself.
- **Player stats.** Add your regulars once. The app tracks win rates for every player, every partnership and every head-to-head matchup.
- **History.** Every game is saved by date. You can resume an unfinished game whenever you like.
- **Fun to use.** Card flips, poker-chip buttons, sound effects and a confetti shower when a team wins. Sound can be turned off with the ♪ button.
- **Works offline.** Once it's on your home screen, it works with no internet connection.

## Put it on your iPad or iPhone

The app is a web app, so there's no App Store and no install fee.

1. Open the app's link in **Safari**. Once GitHub Pages is on, the link is
   `https://fei7fei.github.io/guandan-counter/`.
2. Tap the **Share** button (the square with the arrow pointing up).
3. Tap **Add to Home Screen**, then **Add**.
4. Open it from the new icon. It runs full screen, just like a regular app. 🎉

> **Tip:** iPhones and iPads mute web sounds when the side switch or Control Center has silent mode on. Turn silent mode off to hear the card flips.

### Your data

Everything is saved **on the device** you're using. Nothing is uploaded anywhere. To move to a new device, or just to keep a backup:

- **Players tab → Export backup** saves a `.json` file (on iPad you can choose *Save to Files*).
- **Players tab → Import backup** on the other device loads that file.

Export a backup every so often. It's cheap insurance for years of bragging rights.

## Run it on your computer

There's nothing to install and no build step. It's plain HTML, CSS and JavaScript.

**Quickest:** double-click `index.html` to open it in your browser. Everything works except offline mode.

**Best (offline mode works too):** start a tiny local server from the project folder:

```bash
python -m http.server 8000
```

Then open <http://localhost:8000>.

**Try it on your iPad while you work:** with the server running, find your computer's local IP address (`ipconfig` on Windows) and open `http://<that-ip>:8000` in Safari on the iPad. Both devices need to be on the same Wi-Fi.

## Publish it with GitHub Pages (free)

1. Push to GitHub (see below).
2. On GitHub, open the repo and go to **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to *Deploy from a branch*, choose **main** and **/ (root)**, then click **Save**.
4. About a minute later the app is live at `https://<your-username>.github.io/guandan-counter/`.

Every push to `main` updates the live app automatically.

### Shipping an update

When you change anything, open `sw.js` and bump the version number, for example `guandan-v1` to `guandan-v2`. That tells devices to fetch the new files. Open the app twice and you'll be on the new version.

## Working from another computer

```bash
git clone https://github.com/fei7fei/guandan-counter.git
cd guandan-counter
python -m http.server 8000
```

Make your changes, then:

```bash
git add .
git commit -m "Describe what you changed"
git push
```

## Project map

| File | What's inside |
| --- | --- |
| `index.html` | Page shell and the tab bar |
| `app.js` | Everything else: the game rules, stats, screens, sounds and animations |
| `styles.css` | The card-table look |
| `sw.js` | Offline support (bump the version when you deploy) |
| `manifest.webmanifest` | App name and icon for the home screen |
| `icons/` | App icons |

### How scoring works under the hood

Levels are never stored directly. The app keeps the list of hands and replays it from the start every time. That's why editing an old hand fixes every level after it without any extra work.

## Guandan rules in 30 seconds

- Four players, two partnerships, two decks with all four jokers.
- Each team has a level, starting at **2**. A hand is played at the level of the team that won the last one. The heart of that rank is **wild**.
- When your team wins a hand, you go up based on where your partner finished:
  **1-2 → +3**, **1-3 → +2**, **1-4 → +1**.
- To win the game, your team has to win a hand while playing **A**. Usually a 1-4 finish doesn't count.

Now go deal some cards. Good luck, and may your bombs always land! 💣♠♥♣♦
