ARTICLES = [
    {
        "id": "KB-1001",
        "title": "Unlock a corporate user account",
        "tags": ["locked", "account", "password", "identity"],
        "steps": [
            "Verify the employee identity using the approved challenge.",
            "Confirm the account is locked rather than disabled.",
            "Unlock the account and ask the employee to sign in again.",
        ],
    },
    {
        "id": "KB-1002",
        "title": "Reset a forgotten corporate password",
        "tags": ["password", "reset", "login", "identity"],
        "steps": [
            "Verify identity.",
            "Issue a one-time reset link.",
            "Confirm access after the new password is set.",
        ],
    },
    {
        "id": "KB-1042",
        "title": "Refresh an expired VPN device certificate",
        "tags": ["vpn", "disconnect", "certificate", "two minutes", "authentication"],
        "steps": [
            "Confirm authentication succeeds before the connection drops.",
            "Check the device certificate expiry date.",
            "Refresh the certificate and reconnect the VPN client.",
            "Observe the connection for five minutes.",
        ],
    },
    {
        "id": "KB-1048",
        "title": "Troubleshoot an unstable corporate VPN connection",
        "tags": ["vpn", "unstable", "disconnect", "network", "wifi"],
        "steps": [
            "Confirm whether other internet services remain available.",
            "Capture the VPN client error and connection duration.",
            "Compare behavior on another network.",
        ],
    },
    {
        "id": "KB-1201",
        "title": "Triage a production SAP service outage",
        "tags": ["sap", "outage", "production", "multiple users", "critical"],
        "steps": [
            "Confirm the affected SAP environment and business process.",
            "Check service health and monitoring alerts.",
            "Engage the SAP operations incident commander.",
            "Start the major incident communication process.",
        ],
    },
    {
        "id": "KB-1304",
        "title": "Restore Microsoft Teams audio",
        "tags": ["teams", "audio", "microphone", "meeting"],
        "steps": [
            "Check the selected microphone and speaker.",
            "Verify operating-system microphone permission.",
            "Run a Teams test call.",
        ],
    },
]


def article_context() -> str:
    lines = []
    for article in ARTICLES:
        lines.append(
            f"{article['id']} | {article['title']} | tags: {', '.join(article['tags'])} | "
            f"steps: {'; '.join(article['steps'])}"
        )
    return "\n".join(lines)


def search_articles(text: str, limit: int = 3) -> list[dict]:
    haystack = text.lower()
    scored = []
    for article in ARTICLES:
        hits = sum(1 for tag in article["tags"] if tag in haystack)
        if hits:
            score = min(0.98, 0.55 + hits * 0.1)
            scored.append((score, article))
    scored.sort(key=lambda item: item[0], reverse=True)
    if not scored:
        scored = [(0.52, ARTICLES[3])]
    return [
        {
            "id": article["id"],
            "title": article["title"],
            "score": round(score, 2),
            "reason": _reason(article, haystack),
            "steps": article["steps"],
        }
        for score, article in scored[:limit]
    ]


def _reason(article: dict, text: str) -> str:
    matched = [tag for tag in article["tags"] if tag in text]
    if matched:
        return "Matches the conversation signals: " + ", ".join(matched[:3]) + "."
    return "Provides the closest available troubleshooting workflow."
