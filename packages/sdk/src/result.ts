export type Result<T> = ResultSuccess<T> | ResultError<T>;
export type ResultSuccess<T> = { success: true; data: T; error?: never };
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export type ResultError<T> = { success: false; data?: never; error: Error };
