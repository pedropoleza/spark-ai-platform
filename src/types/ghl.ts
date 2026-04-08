export interface GHLLocation {
  id: string;
  name: string;
  companyId: string;
  timezone: string;
}

export interface GHLUser {
  id: string;
  name: string;
  firstName: string;
  lastName: string;
  email: string;
  role: string;
  type: string;
  permissions: Record<string, unknown>;
}

export interface GHLPipeline {
  id: string;
  name: string;
  stages: GHLPipelineStage[];
  locationId: string;
}

export interface GHLPipelineStage {
  id: string;
  name: string;
  position: number;
}

export interface GHLCalendar {
  id: string;
  name: string;
  locationId: string;
  isActive: boolean;
}

export interface GHLCalendarSlot {
  slots: string[];
}

export interface GHLCalendarFreeSlots {
  [date: string]: GHLCalendarSlot;
}

export interface GHLContact {
  id: string;
  locationId: string;
  firstName: string;
  lastName: string;
  name: string;
  email: string;
  phone: string;
  tags: string[];
  customFields: GHLCustomFieldValue[];
}

export interface GHLCustomField {
  id: string;
  name: string;
  fieldKey: string;
  dataType: string;
  position: number;
}

export interface GHLCustomFieldValue {
  id: string;
  value: string;
}

export interface GHLTag {
  id: string;
  name: string;
  locationId: string;
}

export interface GHLConversation {
  id: string;
  contactId: string;
  locationId: string;
  lastMessageDate: string;
  type: string;
}

export interface GHLMessage {
  id: string;
  conversationId: string;
  contactId: string;
  locationId: string;
  body: string;
  direction: "inbound" | "outbound";
  status: string;
  messageType: string;
  dateAdded: string;
}

export interface GHLWebhookPayload {
  type: string;
  locationId: string;
  contactId: string;
  conversationId?: string;
  body?: string;
  messageType?: string;
  direction?: string;
  customData?: {
    message?: string;
    channel?: string;
    contact_id?: string;
  };
  // Webhook-specific fields
  full_name?: string;
  phone?: string;
  first_name?: string;
}

export interface GHLTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
  locationId?: string;
  companyId?: string;
  userId?: string;
}
