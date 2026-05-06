export function getErrorBoundaryContent(error: Error | null, isDevelopment: boolean) {
  return {
    title: "Something went wrong.",
    description: isDevelopment
      ? "An unexpected error occurred. Review the stack trace below before reloading."
      : "Please reload the page or try again later.",
    stack: isDevelopment ? error?.stack ?? error?.message ?? null : null,
  };
}
