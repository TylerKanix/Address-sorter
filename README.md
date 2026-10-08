# Address Sorter

Upload a spreadsheet of addresses and get them back sorted into the best walking order.

It runs entirely in your web browser. There is nothing to install and no account to create.

## Using it

1. **Open the app.** Use the hosted page (see [Putting it online](#putting-it-online)), or download this repository and double-click `index.html`.
2. **Add your addresses.** Drop in an Excel (`.xlsx`, `.xls`), OpenDocument (`.ods`) or CSV file. You can also paste addresses, one per line, or copy cells straight from a spreadsheet. To see how it works first, press **Try it with sample addresses**.
3. **Check the columns.** The app guesses which column holds the address, and which hold the town, state and ZIP code. Fix any wrong guess with the drop-downs. If your addresses don't include a town (for example just `12 Oak St`), type it in **Town or ZIP to search in**.
4. **Choose how you walk:**
   - **Start:** where the shortest walk begins, at the first address in your list, at another address (for example where you park), or at your current location.
   - **Finish:** anywhere (a one-way walk), or back where you started.
   - **Crossing the street:** zig-zag across whenever that's shorter, or finish one side of a street before doing the other.
5. **Press "Sort into walking order".** You get:
   - a map with numbered pins and the route
   - the sorted list, showing the distance from the previous stop
   - **Download Excel / CSV:** your original spreadsheet with every column kept, re-ordered, with a new *Stop* number column plus coordinates and distances
   - **Print route sheet:** a clean printout with a tick box for each stop
   - **Turn-by-turn directions:** Google Maps walking directions, about 10 stops at a time

### When an address can't be found

- **Not found:** fix the spelling or add the town, then press **Search again**. You can also press **Place on map** and click where the address is.
- **Far away from the rest:** this usually means the address was matched to a street with the same name in another town, so it is left out of the route. Correct it, or press **Keep it** if the location is right.
- **Approximate position:** if only the street could be found, the stop is placed between its neighbouring house numbers.
- Every pin can be dragged to the right spot. Press **Update the route** after making changes.

## How it works

| Step | What happens |
| --- | --- |
| Reading the file | Spreadsheets are read in the browser with [SheetJS](https://sheetjs.com/). Your file is never uploaded anywhere. |
| Finding addresses | US addresses go to the free [US Census Bureau geocoder](https://geocoding.geo.census.gov/), which places house numbers accurately. Everything else, and anything the Census misses, goes to [OpenStreetMap Nominatim](https://nominatim.org/). Only the address text is sent. Results are saved in your browser, so running the same list again is instant. If your file already has latitude and longitude columns, no lookups are made. |
| Choosing the order | The app solves the "travelling salesman" problem: finding the shortest path that visits every stop once. Up to 8 stops are solved exactly. Larger lists use 2-opt and Or-opt improvements, then keep shaking up and re-improving the route until it stops getting shorter, for about 2 seconds at most. Addresses on the same street are kept in house-number order when their exact position isn't known. |
| Distances | Straight-line distances between stops by default. The walking time adds 20% for following streets, at about 3 mph. Under **More options → Use real walking paths (beta)**, distances are measured along footpaths and streets using the public OpenStreetMap walking router. This handles rivers, railways and highways better, and works for up to 200 stops. |
| Map | [Leaflet](https://leafletjs.com/) with OpenStreetMap tiles. |

### Limits and fair use

- OpenStreetMap Nominatim allows **one lookup per second**, so a list of 300 non-US addresses takes about 5 minutes the first time. US addresses found by the Census geocoder are much faster.
- Lookups and the walking router use free public services. They're intended for normal personal use, not for geocoding huge databases.
- Time spent at each door is not included in the walking time.

## Putting it online

The app is a static website: just HTML, CSS and JavaScript, with no server and no build step.

**GitHub Pages (free):** in this repository on GitHub, open **Settings → Pages**. Under *Build and deployment*, choose **Deploy from a branch**, pick your main branch and the `/ (root)` folder, then save. After a minute the app is live at `https://<your-username>.github.io/<repository-name>/`. Open that link on your phone to use it while walking.

**On your own computer:** double-click `index.html`. Hosting it is still recommended, because some lookup services expect requests to come from a real web address. You can also run `npm start` (or `python3 -m http.server 8000`) and open <http://localhost:8000>.

## Claude artifact edition

`artifact/` holds a single-file version that runs as a Claude artifact. Artifacts can't connect to outside services, so that version has no automatic address lookup and no street map. It sorts rows that already have latitude/longitude. For US addresses, it saves a file you upload to the free [US Census batch geocoder](https://geocoding.geo.census.gov/geocoder/locations/addressbatch?form), then reads back the results file the Census gives you.

Build it with `node artifact/build.js` (writes `artifact/address-sorter.html`).

## Development

```
npm test        # unit tests (Node 18+, no dependencies to install)
```

```
index.html              page layout
assets/styles.css       styles, including the print layout
assets/js/address.js    reads CSV/pasted text, detects columns, normalizes addresses
assets/js/geocoder.js   US Census + OpenStreetMap lookups, rate limiting, cache
assets/js/geo.js        distances, outlier detection, house-number interpolation
assets/js/optimizer.js  route optimizer (exact for small lists, then 2-opt / Or-opt + iterated local search)
assets/js/planner.js    turns stops into a route: start/finish options, street-side rules
assets/js/walking.js    optional street-network distances (OSRM foot profile)
assets/js/app.js        the user interface
assets/js/sample.js     sample data for the demo button
examples/               sample spreadsheets (with and without coordinates)
tests/                  unit tests (node:test)
```
