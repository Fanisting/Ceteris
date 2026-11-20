# Ceteris Link connection test

When a [Ceteris Link](ceteris-link.md) window feels slow, the test tells you why: the network, a Tailscale relay, or one tab that sends too much output.

Open Settings → Remote access. Each saved host has a **Test** button next to Connect. The result appears under that host and goes away when you leave the page.

## When the host is connected

The test takes about 5 seconds. Terminal output on that link slows for a few seconds while it runs.

| Line        | What it measures                                                                                     |
| ----------- | ---------------------------------------------------------------------------------------------------- |
| Path        | Direct or relay, read from Tailscale on your computer. A relay is the most common cause of slowness. |
| Round trip  | Median and slowest 5% of 20 pings                                                                    |
| Jitter      | How much the round trip changes from one ping to the next, and how many pings were lost              |
| Download    | Speed from the host to your computer, with a 1 MB sample                                             |
| Upload      | Speed from your computer to the host                                                                 |
| Compression | On when both computers run a version that compresses Link traffic                                    |

Below the numbers, a table lists the remote tabs with the most output in the last 5 minutes: total output, the largest single burst, full-screen redraws and replays. A tab whose largest burst is over 100 KB, or that redrew the whole screen more than 5 times, is marked. Agents such as omp redraw their whole conversation every time the window changes size or you switch back to the tab, so on a long conversation one redraw can be 150 KB or more.

Each finding comes with a plain suggestion, for example "Run tailscale netcheck on both machines" for a relay.

## When the host is not connected

The test checks that the host's port answers and reads the Tailscale path. Connect and test again to see speed and tabs.

## Compression

Link traffic between two computers on this version is compressed. A full redraw from omp is about 4.5 times smaller on the wire, which matters most on a relay. If the other computer runs an older version, the link works as before without compression, and the test says the host needs an update for the speed test.

Related: [Ceteris Link](ceteris-link.md), [Responsive terminals under heavy output](output-flow-control.md). Design: ADR-055 and ADR-056 in the [software definition](../docs/软件定义书.md).
