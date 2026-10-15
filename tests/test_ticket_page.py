import re
from pathlib import Path

APP = (Path(__file__).parent.parent / 'realapp' / 'static' / 'app.js').read_text()


def test_staff_ticket_page_shows_image_analysis_and_ai_help():
    """Technicians must see the image analysis (and the AI help panel) on the ticket page; the analysis is useless if
    it only exists in the data. A UI simplification once removed it silently."""
    body = re.search(r'function staffTicketDetails\(item\) \{(.*?)\n\}\n', APP, re.S).group(1)
    assert 'renderVisualAnalysis(t, item.id)' in body
    assert 'staffAssist(item)' in body
