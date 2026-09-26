/**
 * Temporal failure `type` strings shared by activities (which throw them) and workflows
 * (whose retry policy lists which ones must not be retried). Pure — safe inside the
 * workflow sandbox, unlike @temporalio/activity.
 */
export const FAILURE_PLATFORM_REJECTED = "PlatformRejected";
export const FAILURE_PLATFORM_UNAVAILABLE = "PlatformUnavailable";
export const FAILURE_NOT_IMPLEMENTED = "ActivityNotImplemented";
