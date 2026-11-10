# Connect this machine to another machine over SSH

This guide is read by the AI agent the user started from Ceteris. It walks the user through
opening terminals on another machine (the server) from this one, inside Ceteris. Ceteris is the
terminal manager the user runs; it opens SSH terminals from a profile, so the end state is "a
profile in Ceteris on this machine connects to the server without errors".

## How to work with the user

- Read this whole file first. Follow the section for this machine's operating system; the user's
  message says which one it is. Skip steps that are already done.
- Check before you change: run the read-only checks, report what you found in two or three
  sentences, then propose the next change.
- Get the user's okay before every command that changes something (installing a package, making
  a key, writing `~/.ssh/config`, copying a key to the server).
- Commands that need administrator rights: on Windows, the terminal you run in is probably not
  elevated. Either start the command with
  `Start-Process pwsh -Verb RunAs -ArgumentList '-NoExit','-Command','<command>'`
  (the user sees a UAC prompt), or ask the user to open an administrator shell (the new tab page
  in Ceteris offers "Administrator shell") and paste the command there. On macOS and Linux use
  `sudo` and let the user type the password.
- Ask only what you cannot find out by inspection: the server's address and user name, what it
  runs, and how the two machines reach each other.
- Never print or paste a private key, never suggest turning off host key checking, and never ask
  the user to type a password into the chat.
- Finish with the summary described at the end.

## Step 1: Learn the situation

Ask the user, in one message:

1. The server: its address or host name, the user name there, and what it runs (Windows, macOS,
   Linux). Port, if not 22.
2. How the two machines reach each other: same Wi-Fi or office network, Tailscale, another VPN,
   or not yet decided?
3. Whether SSH login already works from anywhere (for example from a plain terminal), or this is
   the first time.
4. Whether the server runs Ceteris too.

If the server has no SSH service yet, that is set up on the server, not here. When the server
runs Ceteris, the user can click the Local button in its title bar (or open Settings → Remote)
and start the same guide there in the "host" role. Otherwise the short version: Windows needs
the OpenSSH Server capability and the `sshd` service running; macOS needs Remote Login turned on
in System Settings → General → Sharing; Linux needs `openssh-server` installed and the `ssh` or
`sshd` service enabled.

If the machines are not on the same network and nothing connects them yet, recommend Tailscale:
free for personal use, both machines sign in with the same account, every device gets a fixed
`100.x.y.z` address that only the user's own devices can reach. Download at
https://tailscale.com/download. Do this on both machines before continuing.

## Step 2: Install what is missing

Check each tool first and install only what is absent. Report the list to the user before
installing anything.

| Tool | Needed for | Check |
|---|---|---|
| OpenSSH client (`ssh`, `ssh-keygen`, `ssh-agent`) | every connection; Ceteris runs the system `ssh` | `ssh -V` |
| Tailscale | reaching a server on another network | `tailscale status` |
| sshpass (macOS and Linux only) | a profile with a saved password; Ceteris uses sshpass to feed it on these systems. Not needed for key login, and not needed on Windows | `command -v sshpass` |
| tmux (on the server, Linux or macOS) | keeping remote shells alive after a disconnect; Ceteris has a "tmux" launch button for it | `ssh user@address command -v tmux` once login works |

### Windows

The OpenSSH client is a Windows capability (Windows 10 1809 and later, Windows 11) and is
normally present. If `ssh -V` fails (administrator):

```powershell
Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0
```

If that fails with an error about the source, winget has the same package:
`winget install --id Microsoft.OpenSSH.Beta --exact`. winget comes with "App Installer" from
the Microsoft Store; `winget --version` tells whether it is there.

The ssh-agent service holds unlocked keys so a passphrase is typed once. Enable it when the user
wants a passphrase on the key (administrator):

```powershell
Set-Service -Name ssh-agent -StartupType Automatic
Start-Service ssh-agent
```

Tailscale: `winget install --id Tailscale.Tailscale --exact`, or the installer from
https://tailscale.com/download/windows. After installing, the user signs in from the tray icon.

### macOS

The OpenSSH client ships with macOS. Tailscale and sshpass come from the App Store or Homebrew
(`brew --version` tells whether Homebrew is installed; its installer is at https://brew.sh):

```sh
brew install --cask tailscale
brew install hudochenkov/sshpass/sshpass    # only for saved-password profiles
```

### Linux

| Distribution | OpenSSH client | sshpass |
|---|---|---|
| Debian, Ubuntu | `sudo apt install openssh-client` | `sudo apt install sshpass` |
| Fedora, RHEL | `sudo dnf install openssh-clients` | `sudo dnf install sshpass` |
| Arch | `sudo pacman -S openssh` | `sudo pacman -S sshpass` |
| openSUSE | `sudo zypper install openssh-clients` | `sudo zypper install sshpass` |

Tailscale on Linux: `curl -fsSL https://tailscale.com/install.sh | sh`, then `sudo tailscale up`
and sign in with the printed link.

## Step 3: Make a key and put it on the server

Key login is recommended: no password prompts, and it works with Ceteris's background file
browsing (SFTP) without any saved secret.

Check for an existing key first:

- Windows: `Get-ChildItem $env:USERPROFILE\.ssh`
- macOS and Linux: `ls -la ~/.ssh`

If there is no `id_ed25519.pub` (or `id_rsa.pub`), make one. The passphrase is optional; with
one, add the key to ssh-agent so it is typed once:

```sh
ssh-keygen -t ed25519
```

Only the public key (`.pub`) ever leaves this machine. Copy it to the server:

- From macOS or Linux, to any server that accepts passwords: `ssh-copy-id user@address`.
- From Windows, to a macOS or Linux server:

```powershell
type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh user@address "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
```

- To a Windows server: the file depends on whether the user is an administrator there. A normal
  user appends the line to `C:\Users\<user>\.ssh\authorized_keys`. An administrator must use
  `C:\ProgramData\ssh\administrators_authorized_keys` instead, and then run on the server
  (administrator):

```powershell
icacls.exe 'C:\ProgramData\ssh\administrators_authorized_keys' /inheritance:r /grant 'Administrators:F' /grant 'SYSTEM:F'
```

  The easiest way is to show the user the one public key line and have them paste it into that
  file on the server.

## Step 4: Test the plain connection

```sh
ssh user@address
```

The first connection shows the server's host key fingerprint and asks to continue. Answering
yes stores it in `~/.ssh/known_hosts`; Ceteris shows its known hosts and flags a fingerprint
that later changes.

What the common failures mean:

| Message | Likely cause | What to check |
|---|---|---|
| `Connection refused` | no SSH service on the server, or its firewall blocks port 22 | the server side, Step 1 |
| `Connection timed out` | wrong address, or the machines cannot reach each other | `ping address`, `tailscale status` on both |
| `Permission denied (publickey,password)` | wrong user name, key not installed, or Windows administrator key file on the server | Step 3 |
| `Permission denied` right after a password to a Windows server | Microsoft account: the PIN was typed instead of the account password | use keys, or the account password |
| `Bad owner or permissions on ...` | the private key or `~/.ssh` is readable by others | `chmod 600` the key; on Windows `icacls <key> /inheritance:r /grant "$env:USERNAME:R"` |
| `Could not resolve hostname` | a Tailscale name without Tailscale running, or a typo | `tailscale status` |

`ssh -v user@address` prints what the client tried and where it stopped.

## Step 5: Put the server in Ceteris

Two ways; the first is the quickest.

1. Settings → Remote → SSH → add a profile. Fields: a name, host (the address), port, user
   name, and the authentication: key file (pick the private key made in Step 3), ssh-agent, or
   a saved password (encrypted by the operating system; on macOS and Linux it needs sshpass).
   ProxyJump takes a jump host when the server sits behind one.
2. Or write a `Host` block in `~/.ssh/config`; Ceteris lists every Host entry automatically when
   "Integrate ~/.ssh/config" is on in Settings → Remote → SSH (Include is followed, Match blocks
   are skipped):

```
Host desktop
    HostName 100.64.0.2
    User alice
    Port 22
    IdentityFile ~/.ssh/id_ed25519
```

Then, in the sidebar, switch the top toggle from Local to Remote, pick the server, choose a
folder on it, and a terminal opens there. On Windows, login prompts from the background
connection (password, host key, two-factor) show up as a dialog in Ceteris.

When the server is Linux or macOS and has tmux, the "tmux" launch button attaches to a tmux
session that survives disconnects. Windows servers have no tmux.

When the server runs Ceteris on Windows and this machine does too, Ceteris Link can show the
server's own tabs here instead of plain SSH shells: on the server, Settings → Remote → Tailscale,
turn on "Let other machines connect to this one", copy the token; here, Settings → Remote →
Tailscale, add the server with its address, port 38787 and the token. SSH and Link can both be
used.

## Step 6: Summary

End with a short card the user can keep:

- `user@address`, port
- which key file (path on this machine) or that a password is saved
- what was installed or changed on this machine
- the exact command to test: `ssh user@address`
- the Ceteris profile name or `~/.ssh/config` Host name
