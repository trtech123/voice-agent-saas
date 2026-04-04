export interface WizardQuestion {
  question: string;
  key: string;
  options?: string[];
}

export interface ScheduleWindow {
  start: string;
  end: string;
}

export interface UploadResult {
  contactCount: number;
  errors: Array<{ row: number; reason: string }>;
  duplicatesRemoved: number;
  contactIds: string[];
}

export interface WizardState {
  // Step 1: Template
  templateId: string | null;

  // Step 2: Script + Questions
  name: string;
  script: string;
  questions: WizardQuestion[];
  whatsappFollowupTemplate: string;
  whatsappFollowupLink: string;

  // Step 3: Contacts
  uploadResult: UploadResult | null;

  // Step 4: Schedule
  scheduleDays: string[];
  scheduleWindows: ScheduleWindow[];
  maxConcurrentCalls: number;
  maxRetryAttempts: number;
  retryDelayMinutes: number;

  // Step 5: Test + Review
  testCallPhone: string;
  testCallSent: boolean;
}

export const INITIAL_WIZARD_STATE: WizardState = {
  templateId: null,
  name: "",
  script: "",
  questions: [],
  whatsappFollowupTemplate: "",
  whatsappFollowupLink: "",
  uploadResult: null,
  scheduleDays: ["sun", "mon", "tue", "wed", "thu"],
  scheduleWindows: [
    { start: "10:00", end: "13:00" },
    { start: "16:00", end: "19:00" },
  ],
  maxConcurrentCalls: 5,
  maxRetryAttempts: 2,
  retryDelayMinutes: 120,
  testCallPhone: "",
  testCallSent: false,
};
