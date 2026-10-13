# mcumgr-web-dfu

Browser tool for MCUmgr SMP over a serial port (e.g. USB CDC-ACM) on Zephyr /
MCUboot devices: firmware upload, image test/confirm, and reset. Chrome/Edge
only (Web Serial). No build step, no deps.

    ./serve.sh            # then open http://localhost:8000

- **Connect**: pick the port the device runs SMP on (not a log/shell port).
- **Upload**: accepts an MCUboot `*.signed.bin` or a `dfu_application.zip`. After
  upload it can mark the image test/confirmed and reset. With "Reconnect after
  reset" on, it re-finds the port after USB re-enumeration (probes granted ports
  with an echo).
- **Slots**: list, test/confirm a non-active image, confirm a running test image,
  erase slot 1, reset.

MTU defaults to 256 (Zephyr's `CONFIG_MCUMGR_TRANSPORT_UART_MTU` default). If
chunks time out, the device's UART line buffers (`CONFIG_UART_MCUMGR_RX_BUF_COUNT`,
default 2 x 128 B) may be overrunning: raise "Line delay" or the buffer count.

Linux: your user needs access to `/dev/ttyACM*` (`dialout`/`uucp` group).
