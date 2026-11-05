'use client';

import {useEffect, useRef, useState} from 'react';
import {apiRequest} from '@/lib/api';

type Draft = {status: 'draft' | 'needs_review'; text: string | null; business_name?: string; reason?: string};

export default function OutreachPreview({businessName, prospectId, onSaved, onClose}: {businessName: string; prospectId?: string; onSaved?: () => void; onClose: () => void}) {
  const [owner, setOwner] = useState('');
  const [shortName, setShortName] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState('');
  const saveId = useRef<string | null>(null);
  const requestId = useRef(0);

  async function generate(ownerName = owner, alias = shortName) {
    const id = ++requestId.current;
    setSaved(''); saveId.current = null;
    setBusy(true); setError(''); setDraft(null); setCopied(false);
    try {
      const result = await apiRequest<Draft>('/v1/outreach/preview', 'POST', {
        business_name: businessName,
        owner_name: ownerName.trim() || null,
        short_business_name: alias.trim() || null,
      });
      if (id === requestId.current) setDraft(result);
    } catch (e) {
      if (id === requestId.current) setError(e instanceof Error ? e.message : 'Unable to prepare the preview.');
    } finally {
      if (id === requestId.current) setBusy(false);
    }
  }

  useEffect(() => {
    void generate('', '');
    return () => { requestId.current++; };
  }, [businessName]);

  function invalidate() {
    saveId.current = null; setSaved('');
    requestId.current++; setDraft(null); setBusy(false); setCopied(false); setError('');
  }

  async function saveDraft() {
    if (!prospectId || !draft?.text || saving) return;
    const id = requestId.current;
    saveId.current ||= crypto.randomUUID();
    setSaving(true); setError('');
    try {
      const result = await apiRequest<{job:{message_text:string;business_name:string};already_exists:boolean}>('/v1/outreach/jobs','POST',{
        request_id:saveId.current, prospect_id:prospectId,
        owner_name:owner.trim()||null, short_business_name:shortName.trim()||null,
      });
      if (id === requestId.current) {
        setDraft({status:'draft',text:result.job.message_text,business_name:result.job.business_name});
        setSaved(result.already_exists?'An existing draft was found. Its saved message is shown below.':'Draft saved. Review it in Outreach drafts.');
      }
      onSaved?.();
    } catch(e) {if(id===requestId.current)setError(e instanceof Error?e.message:'Unable to save draft.');}
    finally {setSaving(false);}
  }

  async function copy() {
    if (!draft?.text) return;
    try { await navigator.clipboard.writeText(draft.text); setCopied(true); }
    catch { setError('Copy was unavailable. Select the message text and copy it manually.'); }
  }

  return <section aria-label={'Outreach preview for ' + businessName} style={{margin: '20px 0', padding: 'clamp(16px, 3vw, 28px)', background: '#f7f9f6', border: '1px solid #dce5dc', borderRadius: 18}}>
    <div style={{display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'start'}}>
      <div><small style={{color: '#52724b', fontWeight: 700}}>WHATSAPP · MESSAGE PREVIEW</small><h3 style={{margin: '6px 0'}}>{businessName}</h3></div>
      <button className="button button-outline small" onClick={onClose} type="button">Close preview</button>
    </div>
    <form onSubmit={e => {e.preventDefault(); void generate();}} style={{marginTop: 20}}>
      <div style={{display: 'flex', flexWrap: 'wrap', gap: 16}}>
        <label style={{display: 'grid', gap: 6, flex: '1 1 220px'}}>Owner name <small>Optional</small>
          <input value={owner} maxLength={60} disabled={saving} placeholder="Leave blank for a time-based greeting" onChange={e => {invalidate(); setOwner(e.target.value);}} style={{padding: 12, border: '1px solid #cbd5c9', borderRadius: 8, width: '100%'}} />
        </label>
        <label style={{display: 'grid', gap: 6, flex: '1 1 220px'}}>Short business name <small>Optional</small>
          <input value={shortName} maxLength={40} disabled={saving} placeholder="Use the recognizable brand name" onChange={e => {invalidate(); setShortName(e.target.value);}} style={{padding: 12, border: '1px solid #cbd5c9', borderRadius: 8, width: '100%'}} />
        </label>
      </div>
      <button className="button button-dark small" type="submit" disabled={busy||saving} style={{marginTop: 16}}>{busy ? 'Preparing preview…' : 'Update preview'}</button>
    </form>
    <div aria-live="polite" style={{marginTop: 20}}>
      {saved && <p role="status" className="notice">{saved}</p>}
      {error && <p role="alert" className="notice error">{error}</p>}
      {draft?.status === 'needs_review' && <p className="notice">{draft.reason} Enter a short business name above, then update the preview.</p>}
      {draft?.text && <>
        <div style={{background: '#fff', padding: '20px 24px', borderRadius: '16px 16px 16px 4px', border: '1px solid #e0e7dc', maxWidth: 560, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.75}}>{draft.text}</div>
        <p style={{fontSize: 12, marginTop: 10}}>Business name used: {draft.business_name}</p>
        <button type="button" className="button button-outline small" onClick={() => void copy()} style={{marginTop: 12}}>{copied ? 'Copied' : 'Copy message'}</button>
        
      </>}
    </div>
  </section>;
}
