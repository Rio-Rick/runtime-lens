# Runtime Lens: React console.table Webview

This patch adds a React-based Webview table renderer for `console.table`.

Architecture:
- Instrumented `console.table(...)` continues through the existing `Agent.c('table', ...)` path.
- The agent normalizes the call into `LogEvent.table` with rectangular `columns` + `rows`.
- `src/webview/panel.ts` includes the normalized payload in the Webview `snapshot` message.
- `src/webview/main.tsx` receives the payload with `window.addEventListener('message', ...)` and renders `ConsoleTable`.
- Sorting is custom and headless: no table/UI framework is used.
- CSS uses VS Code CSS variables only; React and ReactDOM are bundled into the Webview artifact.

Dependency setup:
- `react`, `react-dom`, `@types/react`, and `@types/react-dom` were added to `package.json`.
- Run `npm install` once in the project to refresh `package-lock.json` and install the new dependencies.
- `npm run compile` then bundles `src/webview/main.tsx` to `out/src/webview/media/main.js`.

Note:
The runtime process cannot directly call the VS Code Webview's `postMessage` API. The existing Runtime Lens transport remains the correct boundary: runtime -> agent/server -> `panel.ts` -> Webview `postMessage` -> React message listener.


## Interactive table features
- Click any header to sort ascending/descending, including `(index)`.
- `Search table...` filters the currently selected table entirely inside React/Webview; it does not change the Runtime Lens event filter.
- `Copy table` copies the visible filtered rows as TSV, so the result can be pasted into Excel, Google Sheets, or a text editor.
- Header resize handles allow manual column width adjustment; the minimum width is 80px.
- `Clear` resets both live history and session counters (`totalAdded` and dropped-event count) so the status bar starts from zero for the new capture session.

## Try it

```bash
npm install
npm run compile
```

Then reload the VS Code extension/development host and open `Runtime Lens Explorer`.

To verify the table UI:

```js
console.table([
  { name: 'Alice', age: 24, role: 'admin' },
  { name: 'Bob', age: 31, role: 'user' },
  { name: 'Charlie', age: 28, role: 'admin' }
]);
```

Expected behavior:
- Click a header to toggle ascending/descending sorting.
- Type into `Search table...` to filter rows without changing the main event search.
- Drag the thin handle at the right edge of a header to resize that column.
- Click `Copy table` and paste into a spreadsheet; the selected/filtered rows are copied as TSV.
- Click `Clear`; the status bar should return to `0 buffered · 0 total` (and no previous dropped count).
