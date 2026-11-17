import { EXIT } from './constants.js';

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export class AitimelineError extends Error {
  readonly exitCode: ExitCode;
  readonly code: string;
  readonly details?: unknown;

  constructor(message: string, exitCode: ExitCode, code: string, details?: unknown) {
    super(message);
    this.name = 'AitimelineError';
    this.exitCode = exitCode;
    this.code = code;
    this.details = details;
  }
}

export class UsageError extends AitimelineError {
  constructor(message: string, details?: unknown) {
    super(message, EXIT.USAGE, 'USAGE_ERROR', details);
    this.name = 'UsageError';
  }
}

export class ValidationError extends AitimelineError {
  constructor(message: string, details?: unknown) {
    super(message, EXIT.VALIDATION_FAILED, 'VALIDATION_ERROR', details);
    this.name = 'ValidationError';
  }
}

export class IoError extends AitimelineError {
  constructor(message: string, details?: unknown) {
    super(message, EXIT.IO_ERROR, 'IO_ERROR', details);
    this.name = 'IoError';
  }
}

export class ScanError extends AitimelineError {
  constructor(message: string, details?: unknown) {
    super(message, EXIT.SCAN_FAILED, 'SCAN_ERROR', details);
    this.name = 'ScanError';
  }
}

export class MergeError extends AitimelineError {
  constructor(message: string, details?: unknown) {
    super(message, EXIT.MERGE_FAILED, 'MERGE_ERROR', details);
    this.name = 'MergeError';
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function errorExitCode(error: unknown): ExitCode {
  if (error instanceof AitimelineError) return error.exitCode;
  return EXIT.INTERNAL;
}
