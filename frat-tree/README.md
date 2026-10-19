# Jews of Yeti family tree

`jews-of-yeti.html` is an interactive fraternity family tree, built as a Claude artifact.

- Each brother appears as a portrait on a brass nameplate, connected to their big and littles.
- Click or tap a brother to open their bio: full photo, nickname, big, littles, their line from the top of the tree, pledge class, graduation year, major, hometown, positions held and a written bio.
- **Add brother** (or **Add a little** from someone's bio) adds a new person under their big. **Edit bio** changes any field, including both photos:
  - **Tree photo**: the small headshot shown on the tree.
  - **Full photo**: the full-length picture shown when the bio is opened.
- **Delete** removes a brother; their littles move up to the deleted brother's big.
- Search by name or nickname, drag to move around, and zoom with the + / − / fit buttons (or Ctrl + scroll).

## Where the data lives

Published on claude.ai, the tree is stored in the artifact's shared database and the photos in its asset store, so everyone the page is shared with sees the same tree. People with Contributor access or higher can add and edit brothers; only Editors and the owner can upload photos.

Opened as a plain file (outside claude.ai), the page still works, but it saves to that browser only (brothers in `localStorage`, photos in IndexedDB).
