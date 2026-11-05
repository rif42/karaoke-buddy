"use strict";
// Shared fake record-page builder for tests: consecutive /track/ + /artist/
// anchors, exactly what the scrape regexes consume.
function pageHtml(name, tracks) {
  const rows = tracks
    .map((t) => `<a href="/track/${t.id}">${t.title}</a>` +
      `<a href="/artist/AAAAAAAAAAAAAAAAAAAAAA">${t.artists[0]}</a>`)
    .join("");
  return `<html><head><title>${name} - playlist by host | Spotify</title></head>` +
    `<body>${rows}</body></html>`;
}

module.exports = { pageHtml };
