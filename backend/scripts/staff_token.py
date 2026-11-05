"""Run interactively from backend/: .venv/bin/python scripts/staff_token.py"""
import getpass
from pathlib import Path
import sys
import httpx

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from app.config import settings

def main():
    cfg=settings()
    email=input('Supabase staff email: ').strip()
    password=getpass.getpass('Password (hidden): ')
    try:
        with httpx.Client(base_url=cfg.supabase_url,timeout=20,follow_redirects=False) as client:
            response=client.post('/auth/v1/token',params={'grant_type':'password'},
                headers={'apikey':cfg.supabase_anon_key},json={'email':email,'password':password})
            del password
            if response.status_code!=200:
                print('Sign-in failed. Check the account password, email confirmation, and Supabase Auth settings.');return 1
            data=response.json()
            token=data['access_token']
            user_id=data['user']['id']
            membership=client.get('/rest/v1/staff_members',headers={'apikey':cfg.supabase_anon_key,'Authorization':'Bearer '+token},
                params={'user_id':'eq.'+user_id,'select':'user_id','limit':1})
            if membership.status_code!=200:
                print('Signed in, but staff access could not be verified. Check the upgrade and membership policy.');return 1
            if not membership.json():
                print('Signed in, but this account needs a public.staff_members row.')
                print('Use this Auth user UUID in the staff membership SQL:',user_id)
                return 1
            print('\nCopy only the next line into Swagger Authorize (without adding Bearer):\n')
            print(token)
            print('\nThis is a temporary user token. Keep it private and rerun this helper when it expires.')
        return 0
    except (httpx.RequestError,ValueError,KeyError):
        print('Unable to complete sign-in. Check Supabase connectivity and configuration.');return 1

if __name__=='__main__':raise SystemExit(main())
