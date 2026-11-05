export type Stage = 'New inquiry' | 'Qualified' | 'Survey scheduled' | 'Proposal sent' | 'Won' | 'Lost';
export type Lead = {id: string; name: string; email: string; phone: string; city: string; address: string; bill: number | null; interest: string; notes: string; consent: boolean; stage: Stage; value: number | null; created_at: string; survey_at: string | null; ai_summary: string | null; followup_draft: string | null; source: string};
export type Job = {id: string; lead_id: string; status: string; attempts: number | null; created_at: string; last_error: string | null};
export const stages: Stage[] = ['New inquiry','Qualified','Survey scheduled','Proposal sent','Won','Lost'];
