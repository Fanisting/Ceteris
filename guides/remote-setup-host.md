# Make this machine an SSH host

This guide is read by the AI agent the user started from Ceteris. It walks the user through
letting other machines open terminals on this one over SSH. Ceteris is the terminal manager the
user runs; it opens SSH terminals from a profile, so the end state is "a profile on the other
machine connects here without errors".

## How to work with the user

- Read this whole file first. Follow the section for this machine's operating system; the user's
  message says which one it is. Skip steps that are already done.
- Check before you change: run the read-only checks, report what you found in two or three
  sentences, then propose the next change.
- Get the user's okay before every command that changes the system (installing a service,
  opening a firewall port, editing the registry or sshd_config, writing an authorized keys file).
  Show the command, say what it does in one sentence, then run it or ask the user to run it.
- Commands that need administrator rights: on Windows, the terminal you run in is probably not
  elevated. Either start the command with
  `Start-Process pwsh -Verb RunAs -ArgumentList '-NoExit','-Command','<command>'`
  (the user sees a UAC prompt), or ask the user to open an administrator shell (the new tab page
  in Ceteris offers "Administrator shell") and paste the command there. On macOS and Linux use
  `sudo` and let the user type the password.
- Ask only what you cannot find out by inspection: what the other machine runs, how the two
  machines reach each other, and whether the user wants key login (recommended) or passwords.
- Never print or paste a private key, never suggest turning off host key checking, and never
  forward port 22 from a home router to the internet.
- Finish with the summary described at the end.

## Step 1: Learn the situation

Ask the user, in one message:

1. What is the other machine: Windows, macOS, Linux, or a phone? Does it run Ceteris?
2. How do the two machines reach each other: same Wi-Fi or office network, Tailscale, another
   VPN, or not yet decided?
3. Key login (recommended, no password prompts) or password login?

If the machines are not on the same network and nothing connects them yet, recommend Tailscale:
free for personal use, both machines sign in with the same account, every device gets a fixed
`100.x.y.z` address that only the user's own devices can reach. Download at
https://tailscale.com/download. Do this on both machines before continuing.

## Step 2: Install what is missing

Check each tool first and install only what is absent. Report the list to the user before
installing anything.

| Tool | Needed for | Check |
|---|---|---|
| OpenSSH server (`sshd`) | accepting logins on this machine | Windows `Get-Service sshd`; macOS `sudo systemsetup -getremotelogin`; Linux `command -v sshd` |
| OpenSSH client (`ssh`, `ssh-keygen`) | testing from here, making keys | `ssh -V` |
| Tailscale | reaching this machine from another network | `tailscale status` |
| tmux (macOS and Linux hosts only) | keeping remote shells alive after a disconnect; Ceteris has a "tmux" launch button for it | `command -v tmux` |

### Windows

The OpenSSH client and server are Windows capabilities (Windows 10 1809 and later, Windows 11).
Both commands need an administrator shell:

```powershell
Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
```

If `Add-WindowsCapability` fails with an error about the source (common on machines with
Windows Update policies), the same packages are available with winget:

```powershell
winget install --id Microsoft.OpenSSH.Beta --exact
```

Tailscale: `winget install --id Tailscale.Tailscale --exact`, or the installer from
https://tailscale.com/download/windows. After installing, the user signs in from the tray icon.

winget itself comes with "App Installer" from the Microsoft Store; `winget --version` tells
whether it is there.

### macOS

The OpenSSH client and server ship with macOS; nothing to install. Tailscale and tmux come from
the App Store or Homebrew (`brew --version` tells whether Homebrew is installed; its installer
is at https://brew.sh):

```sh
brew install --cask tailscale
brew install tmux
```

### Linux

| Distribution | OpenSSH server | OpenSSH client | tmux |
|---|---|---|---|
| Debian, Ubuntu | `sudo apt install openssh-server` | `sudo apt install openssh-client` | `sudo apt install tmux` |
| Fedora, RHEL | `sudo dnf install openssh-server` | `sudo dnf install openssh-clients` | `sudo dnf install tmux` |
| Arch | `sudo pacman -S openssh` | included in `openssh` | `sudo pacman -S tmux` |
| openSUSE | `sudo zypper install openssh-server` | `sudo zypper install openssh-clients` | `sudo zypper install tmux` |

Tailscale on Linux: `curl -fsSL https://tailscale.com/install.sh | sh`, then `sudo tailscale up`
and sign in with the printed link.

## Step 3: Start the SSH server

### Windows

Checks:

```powershell
Get-Service sshd -ErrorAction SilentlyContinue | Select-Object Status, StartType
Get-WindowsCapability -Online | Where-Object Name -like 'OpenSSH.Server*' | Select-Object Name, State
Get-NetFirewallRule -DisplayName '*OpenSSH*' -ErrorAction SilentlyContinue | Select-Object DisplayName, Enabled, Direction
(Get-ItemProperty 'HKLM:\SOFTWARE\OpenSSH' -ErrorAction SilentlyContinue).DefaultShell
```

Start it and keep it running after reboots (administrator):

```powershell
Start-Service sshd
Set-Service -Name sshd -StartupType Automatic
```

If no firewall rule allows inbound port 22, add one (administrator). Installing the capability
normally creates `OpenSSH-Server-In-TCP`; only add a rule when none exists:

```powershell
New-NetFirewallRule -Name sshd -DisplayName 'OpenSSH Server (sshd)' -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22
```

Default shell: without this value a login lands in cmd.exe. Set PowerShell 7 when it is
installed (`(Get-Command pwsh -ErrorAction SilentlyContinue).Source`), else Windows PowerShell
(administrator):

```powershell
New-ItemProperty -Path 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell -PropertyType String -Value 'C:\Program Files\PowerShell\7\pwsh.exe' -Force
```

### macOS

Check:

```sh
sudo systemsetup -getremotelogin
```

Turn it on either in System Settings → General → Sharing → Remote Login (choose which users may
log in), or:

```sh
sudo systemsetup -setremotelogin on
```

The macOS firewall allows Remote Login automatically once it is on. No default shell step is
needed; the login shell is the user's shell (zsh).

### Linux

Find the distribution (`cat /etc/os-release`), then check:

```sh
systemctl status ssh 2>/dev/null || systemctl status sshd 2>/dev/null
command -v sshd
```

Enable and start it. The unit is `ssh` on Debian and Ubuntu, `sshd` on most others:

```sh
sudo systemctl enable --now ssh    # or: sudo systemctl enable --now sshd
```

Firewall, only when one is active:

- ufw: `sudo ufw status`, then `sudo ufw allow OpenSSH`
- firewalld: `sudo firewall-cmd --permanent --add-service=ssh && sudo firewall-cmd --reload`

## Step 4: Find the address and the user name

User name:

- Windows: `whoami` prints `machine\user`; the SSH user name is the part after the backslash.
  If the account signs in with a Microsoft account, the SSH password is the Microsoft account
  password, not the Windows Hello PIN. Many people find that surprising; keys avoid it.
- macOS and Linux: `whoami`.

Address, in order of preference:

1. Tailscale: `tailscale ip -4` on this machine, and `tailscale status` shows every device.
   Tailscale also gives a name (the machine name, lower case) that works instead of the IP.
2. Same local network: Windows `ipconfig` (IPv4 address of the active adapter), macOS
   `ipconfig getifaddr en0`, Linux `ip -4 addr`. These addresses can change after a reboot;
   mention a DHCP reservation in the router when the user cares.
3. Anything else (public IP, port forwarding) is out of scope. Suggest Tailscale instead.

Tell the user the resulting pair in the form `user@address` and the port (22 unless changed).

## Step 5: Set up key login

The key pair is made on the other machine, the one that connects. If that machine already has
`~/.ssh/id_ed25519.pub` (or `id_rsa.pub`), use it; otherwise it runs
`ssh-keygen -t ed25519` and accepts the defaults. Only the public key (`.pub`) ever leaves that
machine. Ask the user to paste the public key here (it is one line starting with `ssh-ed25519`
or `ssh-rsa`), or have them copy it over with `ssh-copy-id user@address` from macOS or Linux.

Where the public key goes on this machine:

### Windows

First find out whether the user is a local administrator:

```powershell
Get-LocalGroupMember -Group Administrators | Select-Object Name
```

- Not an administrator: append the line to `$env:USERPROFILE\.ssh\authorized_keys`
  (create the folder and file when missing).
- An administrator: Windows ignores the per-user file and reads
  `C:\ProgramData\ssh\administrators_authorized_keys` instead. Append the line there, then fix
  the permissions or sshd refuses the file (administrator):

```powershell
icacls.exe 'C:\ProgramData\ssh\administrators_authorized_keys' /inheritance:r /grant 'Administrators:F' /grant 'SYSTEM:F'
```

### macOS and Linux

```sh
mkdir -p ~/.ssh && chmod 700 ~/.ssh
echo '<public key line>' >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

Password login stays on by default on all three systems. If the user wants keys only, set
`PasswordAuthentication no` in sshd_config (`C:\ProgramData\ssh\sshd_config` on Windows,
`/etc/ssh/sshd_config` elsewhere) and restart the service, but only after the key login was
tested.

## Step 6: Test from the other machine

On the other machine:

```sh
ssh user@address
```

What the common failures mean:

| Message | Likely cause | What to check |
|---|---|---|
| `Connection refused` | sshd not running, or firewall blocks port 22 | Step 3 checks |
| `Connection timed out` | wrong address, or the machines cannot reach each other | `ping address`, `tailscale status` |
| `Permission denied (publickey,password)` | wrong user name, key not installed, or Windows administrator key file | Step 4 user name, Step 5 file location |
| `Permission denied` right after typing a password on Windows | Microsoft account: PIN was typed instead of the account password | Use keys, or the account password |
| `Bad owner or permissions on authorized_keys` | file permissions too open | Step 5 chmod or icacls |
| Login works but lands in cmd.exe | DefaultShell not set | Step 3 Windows |

`ssh -v user@address` prints what the client tried and where it stopped.

## Step 7: Open it in Ceteris on the other machine

When the other machine runs Ceteris:

1. Open Settings → Remote → SSH and add a profile. Fields: a name, host (the address from
   Step 4), port, user name, and the authentication: key file (pick the private key), ssh-agent,
   or a saved password.
2. Alternatively add a `Host` block to that machine's `~/.ssh/config`; Ceteris lists every Host
   entry automatically (Include is followed, Match blocks are skipped):

```
Host desktop
    HostName 100.64.0.2
    User alice
    IdentityFile ~/.ssh/id_ed25519
```

3. In the sidebar switch the top toggle from Local to Remote, pick the server and a folder, and a
   terminal opens here. The first connection asks to accept this machine's host key; on Windows
   Ceteris shows that prompt in a dialog.
4. When this machine is Linux or macOS and has tmux installed, the "tmux" launch button keeps
   the remote shell alive across disconnects. Windows hosts have no tmux.

When both machines run Ceteris on Windows and the user wants to see the same tabs on both,
Ceteris Link does that without SSH: Settings → Remote → Tailscale on this machine, turn on
"Let other machines connect to this one", copy the token; on the other machine add this machine
with its address, port 38787 and the token. SSH and Link can both be on.

## Step 8: Summary

End with a short card the user can keep:

- `user@address`, port
- how to log in (key file path on the other machine, or password)
- what was changed on this machine (service, firewall rule, registry value, key file)
- the exact command to test: `ssh user@address`
