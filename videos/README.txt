3rd Eyes — Explainer Video Drop-In
===================================

Drop your finished explainer video into THIS folder named exactly:

    explainer.mp4      (primary — required)
    explainer.webm     (optional — smaller files for modern browsers)

The site auto-detects on every page load. No code change needed.

If the video loads → it plays and replaces the CSS animation.
If the file is missing or fails to load → CSS animation stays.

Recommended specs
-----------------
  Duration:   20–40 seconds (loops continuously, so keep it tight)
  Aspect:     16:9 (1280×720 or 1920×1080)
  Format:     MP4 H.264, AAC audio OR muted
  File size:  Under 8 MB (use HandBrake or ffmpeg to compress)
  Frame rate: 24 or 30 fps
  Audio:      Optional — the <video> tag has muted autoplay (required for autoplay
              on mobile browsers). If you want users to hear narration, add an
              unmute button. Otherwise use on-screen text + visuals only.

Storyboard the current CSS scene tells (use this as the script if you commission one)
-------------------------------------------------------------------------------------
  0–5 sec   "It's Tuesday."          Show forecast: Chicago, 51°F predicted high
  5–10 sec  "Kalshi sells a bet."    Show Kalshi market: 'Will Chicago hit 62°F?' · NO @ 95¢
  10–15 sec "You get a text."        Show phone with Telegram alert popping up
  15–20 sec "Closed at 50°F. +$2.18" Show result + green profit number

Suggested production routes
---------------------------
  Synthesia.io        — AI avatar + voiceover, ~$30, 10-min render
  Fiverr motion       — search "explainer animation under 30s", $50–150, 2–3 days
  Canva animated PNG  — free, manual scenes, 2 hours of your time
  ScreenFlow / Loom   — record yourself narrating w/ on-screen visuals, free
  Runway ML           — AI video from prompts, ~$15/video

Compressing oversized files
---------------------------
If your final export is too big, use HandBrake (free) with preset:
  "Web > Vimeo YouTube HQ 1080p30" — usually drops 50MB → 5MB without visible loss.

That's it. Drop the file, refresh the site, you're live.
