# mcumgr-web-dfu

Tool for MCUmgr SMP over a serial port (e.g. USB CDC-ACM) on Zephyr / MCUboot
devices: firmware upload, image test/confirm, and reset. Runs in Chrome/Edge
(Web Serial) from `web/` with no build step, or as a standalone Electron app.

    ./serve.sh            # browser: open http://localhost:8000
    npm install && npm start            # Electron app
    npm run dist:win      # Windows portable + installer .exe in dist/

`web/` is published to GitHub Pages on push to main. Pushing a `v*` tag builds
the Windows app and attaches it to a GitHub release (`release.yml`). The
Electron app runs fully offline and shows its own port picker with COM names.

- **Connect**: pick the port the device runs SMP on (not a log/shell port).
- **Upload**: accepts an MCUboot `*.signed.bin` or a `dfu_application.zip`. After
  upload it can mark the image test/confirmed and reset. With "Reconnect after
  reset" on, it re-finds the port after USB re-enumeration (probes granted ports
  with an echo).
- **Image / Slot**: "Image" is the SMP upload image number (default 0 = secondary
  slot of image 0; with `CONFIG_MCUMGR_GRP_IMG_DIRECT_UPLOAD`, N > 0 writes slot
  N-1). "Slot" (default 1) locates the upload for marking and is what Erase
  erases. A zip's `manifest.json` (`image_index`, optional `slot`) sets both.
  Images MCUboot doesn't manage aren't in the slot list, so they're not marked.
- **Slots**: list, test/confirm a non-active image, confirm a running test image,
  erase the selected slot, reset.

MTU defaults to 256 (Zephyr's `CONFIG_MCUMGR_TRANSPORT_UART_MTU` default). If
chunks time out, the device's UART line buffers (`CONFIG_UART_MCUMGR_RX_BUF_COUNT`,
default 2 x 128 B) may be overrunning: raise "Line delay" or the buffer count.

Linux: your user needs access to `/dev/ttyACM*` (`dialout`/`uucp` group).
