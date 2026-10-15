"""One fixed list of services, so analytics, filters and routing count the same thing once.

The AI, customers and older records all name services freely ("Printing Services", "Microsoft Outlook",
"GlobalProtect VPN"). normalize_service maps any such name onto the list; unknown names become General.
"""
import re

SERVICES = (
    'Accounts & access',
    'Email & Outlook',
    'Network & VPN',
    'Printing',
    'Microsoft Teams',
    'Windows & devices',
    'Software & apps',
    'Business applications',
    'General',
)
SERVICE_LIST = ', '.join(SERVICES)   # for AI prompts

# First match wins, so the more specific words come first ("Teams" before "Microsoft 365").
_RULES = (
    ('Email & Outlook', r'outlook|e-?mail|\bmail|exchange|inbox|calendar'),
    ('Microsoft Teams', r'\bteams\b'),
    ('Network & VPN', r'vpn|globalprotect|anyconnect|network|wi-?fi|wireless|internet|connectivity|proxy|firewall|dns|ethernet'),
    ('Printing', r'print|scan'),
    ('Accounts & access', r'identity|access|account|password|login|log-in|sign-?in|sso|mfa|multi-factor|active directory|\bad\b|okta|permission'),
    ('Business applications', r'payroll|\bhr system|finance system|database|\bsql\b|\bapi\b|gateway|server|\bsap\b|\bcrm\b|\berp\b|portal|reporting|business app'),
    ('Windows & devices', r'windows|laptop|desktop|workstation|device|hardware|monitor|display|keyboard|mouse|end user computing|\bpc\b|\bmac\b|endpoint|dock'),
    ('Software & apps', r'software|application|\bapp\b|apps|office|microsoft 365|m365|google workspace|excel|word|powerpoint|install|licen[cs]e|browser|chrome|zoom'),
)
_EXACT = {name.lower(): name for name in SERVICES}


def normalize_service(value: str | None) -> str:
    text = (value or '').strip()
    if not text:
        return 'General'
    if text.lower() in _EXACT:
        return _EXACT[text.lower()]
    lowered = text.lower()
    for name, pattern in _RULES:
        if re.search(pattern, lowered):
            return name
    return 'General'


def skill_matches(service: str, skills: list[str]) -> bool:
    """A technician skill like "vpn" or "outlook" matches the service it normalises to."""
    target = normalize_service(service)
    return target != 'General' and any(normalize_service(skill) == target for skill in skills)
