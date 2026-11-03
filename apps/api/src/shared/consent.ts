/** Consent Mode v2 signals sent by the LP banner (tracking §4). Absent object = all denied. */
export type ConsentValue = 'granted' | 'denied';

export interface ConsentState {
  readonly analyticsStorage: ConsentValue;
  readonly adStorage: ConsentValue;
  readonly adUserData: ConsentValue;
  readonly adPersonalization: ConsentValue;
}

/** Purposes recorded append-only in capture.consents (R4). */
export type ConsentPurpose = 'privacy_policy' | 'marketing_communications' | 'ad_tracking';
