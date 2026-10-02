/**
 * Error codes returned to the agent. They are stable, machine-readable and
 * map onto decisions an agent can actually make (fix input, retry later,
 * escalate to a human).
 */
export type ConnectorErrorCode =
  /** Tool arguments failed validation. Fix the arguments and call again. */
  | 'INVALID_INPUT'
  /** Freshdesk rejected the request as invalid (HTTP 400 and other 4xx). */
  | 'INVALID_REQUEST'
  /** The API key was rejected (HTTP 401). Needs a human to fix configuration. */
  | 'AUTHENTICATION_FAILED'
  /** The API key's agent lacks access, or the account/plan blocks API use (HTTP 403). */
  | 'PERMISSION_DENIED'
  /** The resource does not exist or is not visible to this API key (HTTP 404). */
  | 'NOT_FOUND'
  /** Freshdesk rate limit hit and automatic retries were exhausted or would wait too long. */
  | 'RATE_LIMITED'
  /** Freshdesk returned a 5xx, a redirect, or a response this connector could not understand. */
  | 'UPSTREAM_ERROR'
  /** Freshdesk could not be reached. */
  | 'NETWORK_ERROR'
  /** Freshdesk did not answer within the configured timeout. */
  | 'TIMEOUT'
  /** Unexpected bug inside the connector. Details are logged, never returned. */
  | 'INTERNAL_ERROR';

export interface FieldError {
  field?: string;
  message: string;
  code?: string;
}

export interface ConnectorErrorOptions {
  code: ConnectorErrorCode;
  message: string;
  retryable?: boolean;
  httpStatus?: number;
  retryAfterMs?: number;
  attempts?: number;
  details?: FieldError[];
}

/** JSON shape returned to the agent when a tool call fails. */
export interface ToolErrorPayload {
  error: {
    code: ConnectorErrorCode;
    message: string;
    retryable: boolean;
    http_status?: number;
    retry_after_seconds?: number;
    attempts?: number;
    details?: FieldError[];
  };
}

export class ConnectorError extends Error {
  readonly code: ConnectorErrorCode;
  readonly retryable: boolean;
  readonly httpStatus: number | undefined;
  readonly retryAfterMs: number | undefined;
  readonly attempts: number | undefined;
  readonly details: FieldError[] | undefined;

  constructor(options: ConnectorErrorOptions) {
    super(options.message);
    this.name = 'ConnectorError';
    this.code = options.code;
    this.retryable = options.retryable ?? false;
    this.httpStatus = options.httpStatus;
    this.retryAfterMs = options.retryAfterMs;
    this.attempts = options.attempts;
    this.details = options.details;
  }

  /** Returns a copy that records how many attempts were made, optionally explaining why we stopped. */
  afterAttempts(attempts: number, note?: string, retryAfterMs: number | undefined = this.retryAfterMs): ConnectorError {
    return new ConnectorError({
      code: this.code,
      message: note ? `${this.message} ${note}` : this.message,
      retryable: this.retryable,
      httpStatus: this.httpStatus,
      retryAfterMs,
      attempts,
      details: this.details,
    });
  }

  toPayload(): ToolErrorPayload {
    return {
      error: {
        code: this.code,
        message: this.message,
        retryable: this.retryable,
        ...(this.httpStatus !== undefined && { http_status: this.httpStatus }),
        ...(this.retryAfterMs !== undefined && {
          retry_after_seconds: Math.ceil(this.retryAfterMs / 1000),
        }),
        ...(this.attempts !== undefined && { attempts: this.attempts }),
        ...(this.details?.length && { details: this.details }),
      },
    };
  }
}

/** Thrown at startup when environment configuration is missing or invalid. */
export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}
