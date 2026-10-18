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


def routing_category(value: str | None) -> str:
    """Map the detailed service catalog and broad technician tags to the POC's three routing buckets."""
    lowered = (value or '').strip().casefold()
    if lowered in {'software', 'software/apps', 'software & apps'}:
        return 'software'
    if lowered in {'hardware', 'windows & devices'}:
        return 'hardware'
    service = normalize_service(value)
    if service in {'Email & Outlook', 'Microsoft Teams', 'Software & apps', 'Business applications'}:
        return 'software'
    if service in {'Windows & devices', 'Printing'}:
        return 'hardware'
    return 'general'


_CATEGORY_TERMS = {
    'software': (
        (4, 'explicit_software', r'\bsoftware\b'),
        (3, 'app_or_program', r'\bapplications?\b|\bapps?\b|\bprogram(?:me)?s?\b'),
        (2, 'known_software_product', r'\boutlook\b|\bexcel\b|\bword\b|\bpowerpoint\b|\bteams\b|\bchrome\b|\bbrowser\b|\bzoom\b|\bpayroll\b|\bsap\b|\bcrm\b|\berp\b'),
    ),
    'hardware': (
        (4, 'explicit_hardware', r'\bhardware\b'),
        (3, 'hardware_device', r'\blaptops?\b|\bdesktops?\b|\bprinters?\b|\bmonitors?\b|\bkeyboards?\b|\bmice\b|\bmouse\b|\bdocks?\b|\bheadsets?\b|\bdevices?\b|\bscanners?\b'),
        (2, 'hardware_component', r'\b(screen|display|power supply|battery|port|webcam|camera)\b'),
    ),
}


def classify_routing_category(text: str, service: str | None = None) -> tuple[str, list[str]]:
    """Classify only clearly evidenced software/hardware issues; leave ambiguous requests general."""
    scores, evidence = {}, {}
    lowered = (text or '').casefold()
    for category, rules in _CATEGORY_TERMS.items():
        hits = [(weight, label) for weight, label, pattern in rules if re.search(pattern, lowered)]
        if hits:
            scores[category] = sum(weight for weight, _ in hits)
            evidence[category] = [label for _, label in hits]
    if scores:
        highest = max(scores.values())
        winners = [category for category, score in scores.items() if score == highest]
        if len(winners) == 1:
            category = winners[0]
            return category, evidence[category]
        fallback = routing_category(service)
        return (fallback, evidence.get(fallback, [])) if fallback in winners else ('general', [])
    return routing_category(service), []


def skill_matches(service: str, skills: list[str]) -> bool:
    """Match a detailed service or one of the POC's broad software/hardware tags."""
    target = normalize_service(service)
    if target == 'General':
        return False
    category = routing_category(target)
    return any(normalize_service(skill) == target or
               (category in {'software', 'hardware'} and routing_category(skill) == category)
               for skill in skills)
