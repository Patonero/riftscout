# RiftScout

A Chrome extension that shows each player's [eloshowdown.com](https://eloshowdown.com/riftbound/) ELO rating right on a Riftbound event's roster — no more searching each name by hand. Works on:

- `locator.riftbound.uvsgames.com` event pages
- `playriftbound.com` event pages

## Install it (2 minutes, no coding required)

This isn't on the Chrome Web Store yet, so it installs the same way any "developer" extension does — by loading the folder directly. It's totally safe, just an extra step Chrome requires for extensions from outside the Store.

1. **Download the extension**
   - Go to the [**Releases** page](https://github.com/Patonero/riftscout/releases/latest) and download the `riftscout-vX.Y.Z.zip` file under **Assets**.
   - **Unzip it** (right-click → Extract All on Windows, or double-click on Mac). You'll get a `riftscout` folder — remember where you put it, you'll need it in step 4.
2. **Open Chrome's extensions page**
   - Go to `chrome://extensions` (paste that into your address bar).
3. **Turn on Developer mode**
   - Flip the **Developer mode** toggle in the top-right corner of that page.
4. **Load the extension**
   - Click **Load unpacked**.
   - Select the unzipped `riftscout` folder (the one containing `manifest.json`).
   - RiftScout should now appear in your extensions list.

That's it — no restart needed.

## Using it

1. Open any event page on either supported site (e.g. `https://locator.riftbound.uvsgames.com/events` or a `playriftbound.com` event).
2. Find the roster / "Registered Players" list.
3. Click **Scout ELOs**.
4. Each player gets a colored badge with their ELO:
   - 🟢 green = high ELO, 🟡 amber = mid, ⚪ gray = lower, 🟣 purple `~1234` = a best-guess match (name shared by multiple accounts), dashed "ELO ?" = no confident match found.
   - Hover any badge for details (match count, community, or why a guess/miss happened).

## Getting updates

Since this installs from a downloaded folder rather than the Chrome Web Store, it won't auto-update. When a new version comes out, download the latest zip from [Releases](https://github.com/Patonero/riftscout/releases/latest), unzip it over the old `riftscout` folder, then go to `chrome://extensions` and click the reload icon (⟳) on RiftScout's card — no need to remove and re-add it.

## Privacy

RiftScout doesn't collect any personal data. See the [privacy policy](https://claude.ai/artifact/RGwKfpiSt6ZoVaedfR3Tv4) for details.
