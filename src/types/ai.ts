export interface AIAction {
  type: "send_message" | "update_field" | "add_tag" | "remove_tag" | "book_appointment" | "reschedule_appointment" | "move_pipeline";
  field_key?: string;
  value?: string;
  tag?: string;
  calendar_id?: string;
  start_time?: string;
  appointment_id?: string;  // para reschedule
  title?: string;
  pipeline_id?: string;
  stage_id?: string;
}

export interface AIResponse {
  message: string | string[];
  should_send_message: boolean;
  actions: AIAction[];
  internal_notes: string;
  collected_data: Record<string, string>;
  conversation_status: "active" | "qualified" | "booked" | "disqualified" | "handed_off";
}

export interface AIProcessingResult {
  success: boolean;
  response: AIResponse | null;
  error?: string;
  prompt_tokens?: number;
  completion_tokens?: number;
  cached_tokens?: number;
  duration_ms?: number;
  cache_hit_ratio?: number;
  /**
   * True quando a IA retornou resposta não-parseável e caímos no fallback
   * genérico. Usado pelo processor para detectar loops e pausar conversa.
   */
  parse_failed?: boolean;
}
