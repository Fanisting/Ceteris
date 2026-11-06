/**
 * @file src/main/platform/askpass.ts
 * @purpose The contract between ssh, SSH_ASKPASS and the helper that supplies a saved password.
 *
 * In a file of its own so that sftp-client.ts need not load every platform adapter, and
 * index.ts and windows.ts need not import each other.
 */

/** Carries a saved password to the helper. Never put it on a command line. */
export const ASKPASS_PASSWORD_ENV = 'CETERIS_SSH_PASSWORD';

/**
 * PowerShell reads the variable, so the password never passes through cmd, where % ^ & and
 * quotes would be interpreted. UTF-8 and no newline: ssh sends exactly what it reads.
 */
export const WINDOWS_ASKPASS_HELPER =
  '@echo off\r\n' +
  '@powershell -NoProfile -NonInteractive -Command ' +
  `"[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); ` +
  `[Console]::Out.Write($env:${ASKPASS_PASSWORD_ENV})"\r\n`;
