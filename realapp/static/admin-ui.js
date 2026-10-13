(() => {
  // Keep visual analytics and add a keyboard/screen-reader friendly data table for each chart.
  const renderBars = window.renderAnalyticsBars;
  if (typeof renderBars === 'function') {
    window.renderAnalyticsBars = (target, counts, total) => {
      renderBars(target, counts, total);
      const host = document.querySelector(target);
      if (!host) return;
      let wrapper = host.nextElementSibling;
      if (!wrapper?.classList.contains('chart-data-table')) {
        wrapper = document.createElement('div'); wrapper.className = 'chart-data-table'; host.after(wrapper);
      }
      wrapper.replaceChildren();
      if (!Object.keys(counts || {}).length) return;
      const table = document.createElement('table');
      const caption = document.createElement('caption'); caption.textContent = 'Chart data';
      const head = document.createElement('thead'); head.innerHTML = '<tr><th scope="col">Category</th><th scope="col">Count</th><th scope="col">Share</th></tr>';
      const body = document.createElement('tbody');
      Object.entries(counts).sort((a,b) => b[1]-a[1]).forEach(([name,count]) => {
        const row = document.createElement('tr');
        [name, String(count), `${Math.round(count / Math.max(1,total) * 100)}%`].forEach((value,index) => { const cell=document.createElement(index ? 'td' : 'th'); if (!index) cell.scope='row'; cell.textContent=value; row.append(cell); });
        body.append(row);
      });
      table.append(caption,head,body); wrapper.append(table);
    };
  }

  document.querySelectorAll('.analytics-metrics article, #analytics-calls-panel .metrics article').forEach(card => {
    const small = card.querySelector('small');
    if (small && !small.dataset.definition) { small.dataset.definition='true'; small.title = `${card.querySelector('span')?.textContent || 'Metric'} · current loaded dataset`; }
  });

  const status = document.querySelector('#systemStatus');
  if (status) {
    status.setAttribute('role','status'); status.setAttribute('aria-live','polite');
    const retry = document.createElement('button'); retry.type='button'; retry.className='key-link'; retry.textContent='Retry connection'; retry.setAttribute('aria-label','Retry AI connection check');
    retry.addEventListener('click', async () => {
      retry.disabled=true; retry.textContent='Checking…';
      try { await window.loadConfig(); retry.textContent='Retry connection'; }
      catch (error) { status.textContent='Connection check failed'; retry.textContent='Try again'; }
      finally { retry.disabled=false; }
    });
    status.insertAdjacentElement('afterend', retry);
  }
})();
