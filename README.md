# My Book Reviews

A small static site for logging book reviews: title, cover, rating, format, dates, summary, thoughts and favorite quotes. Reviews are stored in the browser and synced to a Google Sheet.

- `index.html`: markup and styles
- `app.js`: all logic
- `apps-script/Code.gs`: the Google Apps Script backend for the Sheet

## Features

- Add, edit and delete reviews. Edits update the existing review (they no longer create a new Sheet row).
- Search by title, author, summary, thoughts or quotes. Sort by date added, date finished, rating or title. Filter by rating and format.
- Yearly reading galleries. A book appears in the year it was finished, or started if it has no end date.
- Stats tab with books per year, average rating, rating distribution, formats and most-read authors.
- "Find cover" looks up a cover on Open Library from the title and author.
- Export and import a JSON backup from the Stats tab.
- Changes made while offline are queued and sent when the connection returns.

## Updating the Google Sheet backend

The site works without this, but loading from the Sheet and syncing edits and deletes need the new script:

1. Open your Sheet, then **Extensions > Apps Script**.
2. Replace the code with `apps-script/Code.gs`.
3. **Deploy > Manage deployments**, edit the existing web app deployment and choose **New version**. Keep "Execute as: Me" and "Who has access: Anyone" so the URL in `app.js` stays the same.

The script reads your existing header row. It adds `id` and `updatedAt` columns and gives older rows an id the first time the list is loaded.

## Notes

- The Apps Script URL in `app.js` is public. Anyone who finds it can write to the Sheet. The script caps cell length and ignores formula injection, but it has no authentication.
- Data is kept in `localStorage`. Use **Export backup** before clearing browser data.
