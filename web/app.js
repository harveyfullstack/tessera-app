(() => {
  const data = window.TESSERA_DELIVERIES;

  const STATUS_LABELS = {
    delivered: "Delivered",
    retrying: "Retrying",
    dead_letter: "Dead-lettered",
  };

  const formatNumber = (value) => value.toLocaleString("en-US");

  document.getElementById("window-label").textContent = data.window;

  const kpis = [
    { label: "Deliveries", value: formatNumber(data.totals.deliveries) },
    { label: "Success rate", value: `${data.totals.successRate}%` },
    { label: "Median latency", value: `${data.totals.medianLatencyMs} ms` },
    { label: "Retrying", value: formatNumber(data.totals.retrying) },
  ];

  document.getElementById("kpis").innerHTML = kpis
    .map(
      (kpi) => `
        <div class="kpi">
          <span class="kpi-label">${kpi.label}</span>
          <span class="kpi-value">${kpi.value}</span>
        </div>`,
    )
    .join("");

  document.getElementById("endpoint-rows").innerHTML = data.endpoints
    .map(
      (endpoint) => `
        <tr>
          <td class="customer">${endpoint.customer}</td>
          <td class="mono">${endpoint.url}</td>
          <td class="mono">${endpoint.eventType}</td>
          <td>${endpoint.attempts}</td>
          <td class="subtle">${endpoint.lastAttempt}</td>
          <td><span class="pill pill-${endpoint.status}">${STATUS_LABELS[endpoint.status]}</span></td>
        </tr>`,
    )
    .join("");
})();
