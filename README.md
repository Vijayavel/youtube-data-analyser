# Channel Upload Tracker

A static web app that lists every public video a YouTube channel uploaded in the last N days (default 30) and charts their view counts over time.

## Run

```sh
cd path/to/this/folder
python3 serve.py        # serves on port 8000 with caching off, so edits show up on reload
# open http://localhost:8000
```

Opening `index.html` directly from the file system also works.

## Setup: YouTube Data API key

1. Go to https://console.cloud.google.com/ and create (or pick) a project.
2. **APIs & Services → Library**: enable **YouTube Data API v3**.
3. **APIs & Services → Credentials → Create credentials → API key**.
4. Optional but recommended: restrict the key to the YouTube Data API v3 and to HTTP referrer `http://localhost:8000/*`.
5. In the app, click **Settings** (top right), paste the key and click **Save**. It is stored only in this browser. Until a key is saved, the Settings button shows **No API key**.

## Usage

Enter a channel in any of these forms:

- `@handle`
- `https://www.youtube.com/@handle`
- `https://www.youtube.com/channel/UC...` or a bare `UC...` ID
- `https://www.youtube.com/user/name`
- a channel name (falls back to search)

You can prefill the channel with `?channel=@handle` in the URL.

The app shows:

- **Time-series chart**: each video's view count plotted at its publish time, with:
  - a **trend line**: a smooth 2-day average of views per video (5-day when Days is over 100), shown when there are 2 or more videos (see *Trend line* below);
  - a dashed **average line**: mean views across the videos shown.
  Hover a point for a card with the thumbnail, views, % vs. average and the trend value; click it to open the video.
- **Min / Max length filters**: only videos within this length range, in minutes, are shown. Min defaults to 1, which hides most Shorts. Max is empty by default, meaning no limit. Leave both empty or 0 to show everything, including live and upcoming videos. Changing either updates the chart, hashtags and table instantly, without another API call. If min is more than max, the Max box is outlined in red and nothing is shown.
- **Hashtags**: the hashtags (from titles and descriptions) used by the most-viewed video, and the top 10 hashtags ranked by total views of the videos using them. Hashtags on the top video are marked. Both follow the length filters.
- **Sortable table**: publish date, length, views and likes.

## Compare channels tab

Compare up to 5 channels on one graph.

- **Channels**: start with two rows. Use **+ Add channel** to add more (up to 5) and **×** to remove one. Each row's colour matches that channel's lines on the chart.
- **Filters**: Days, Min length and Max length work the same as on the Channel tab. Changing Min or Max length updates the results instantly.
- **Chart**: no individual video points. Each channel has two lines in its colour:
  - a solid **trend line**: the same smooth 2- or 5-day average as the Channel tab (see *Trend line* below);
  - a dashed **average line**: the channel's average views per video.
  Each line is labelled at the right edge with the channel name or "Avg …" value, with labels moved apart so they don't overlap.
  - Click a channel in the legend to hide or show it.
  - **Log scale** helps when channels have very different view counts.
  - Hovering shows a date cursor with every channel's trend value on that day, highest first, and how each compares to its channel's average.
- **Channel summary table**: subscribers, number of videos, total views, average views, latest trend value and top video for each channel.
- If a channel can't be found, the rest still load and the status line says which one failed. Entering the same channel twice only loads it once.
- Prefill channels with `?compare=@a,@b,@c#compare` in the URL.

The API key is set once in **Settings** and shared by both tabs.

## Recent videos are excluded

Videos published in the last 24 hours are always left out, because they're still collecting their first views and would pull averages and trends down. **Days** counts back from 24 hours ago, so Days = 30 covers videos published between 31 days and 24 hours ago. Both tabs work this way.

## Trend line

Both tabs use the same trend: for each point in time, the average views of videos published within about 2 days (5 days when Days is over 100), with closer videos counting more. This gives a smooth curve that doesn't jump when several videos are published close together. The line runs from the first to the last video in the period. To change the windows, edit `trendDays` in `app.js`.

## Notes

- The YouTube API only returns each video's **current** total view count, not its view history. The chart places those totals on each video's publish date. Per-day view history needs the YouTube Analytics API, which only works for channels you own.
- Quota cost is about 3–5 units per lookup out of a 10,000/day default. Resolving a channel by name through search costs 100 units.
