"""Run explicitly: python scripts/seed_demo.py --export-dir ..

Requires the existing local administrator; never changes its credentials.
"""
import argparse
from pathlib import Path
import sys

root = Path(__file__).resolve().parents[1]
sys.path.insert(0,str(root))

from realapp.calling import CallingService
from realapp.calling_store import create_calling_store
from realapp.config import Settings
from realapp.demo_dataset import import_dataset, export_dataset
from realapp.engine import create_engine
from realapp.store import create_store


def main():
    parser=argparse.ArgumentParser(description='Import the requested 85 synthetic demo conversations into local ResolveAI.')
    parser.add_argument('--export-dir',default=str(root.parent))
    args=parser.parse_args()
    settings=Settings()
    if settings.environment!='local' or settings.data_backend!='sqlite' or settings.calling_backend!='sqlite':
        raise SystemExit('This importer is intended for the local SQLite website.')
    store=create_store(settings)
    service=CallingService(settings,create_calling_store(settings),store,create_engine(settings,store.list_knowledge))
    if not any(user['role']=='admin' for user in service.snapshot()['technicians']):
        raise SystemExit('Create the administrator account in ResolveAI before importing demo accounts.')
    result=import_dataset(service,store,credentials_path=root/'data/demo_account_logins.csv')
    export_dataset(result,args.export_dir)
    print(f"Created {result['created_accounts']} accounts, {result['created_calls']} calls, {result['created_incidents']} incidents.")
    print('Demo dataset: 20 technicians, 30 customers, 85 linked calls/incidents. Existing records preserved.')
    print('Account logins saved locally to data/demo_account_logins.csv; passwords excluded from exports.')


if __name__=='__main__':
    main()
