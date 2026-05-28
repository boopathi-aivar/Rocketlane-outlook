import axios from 'axios';
import type { RoleBucket } from './types';

const QUICKCHART_URL = 'https://quickchart.io/chart';

async function postChart(chart: unknown, width: number, height: number): Promise<Buffer | null> {
  try {
    const { data } = await axios.post(
      QUICKCHART_URL,
      {
        chart,
        width,
        height,
        backgroundColor: 'white',
        format: 'png',
        version: '4',
        devicePixelRatio: 2,
      },
      { responseType: 'arraybuffer', timeout: 20000 },
    );
    return Buffer.from(data);
  } catch (err) {
    console.warn('Chart render failed', err);
    return null;
  }
}

export async function renderSummaryChart(
  blocked: number,
  delayed: number,
): Promise<Buffer | null> {
  const total = blocked + delayed;
  if (total === 0) return null;

  const chart = {
    type: 'bar',
    data: {
      labels: ['Blocked', 'Delayed'],
      datasets: [
        {
          label: 'Projects',
          data: [blocked, delayed],
          backgroundColor: ['#d93025', '#f4b400'],
          borderColor: ['#a50e0e', '#c08400'],
          borderWidth: 1,
        },
      ],
    },
    options: {
      indexAxis: 'y',
      plugins: {
        legend: { display: false },
        title: {
          display: true,
          text: `${total} project${total === 1 ? '' : 's'} requiring attention`,
          font: { size: 16, weight: 'bold' },
          padding: { top: 6, bottom: 12 },
        },
        datalabels: {
          anchor: 'end',
          align: 'end',
          color: '#202124',
          font: { size: 14, weight: 'bold' },
          offset: 4,
        },
      },
      scales: {
        x: {
          beginAtZero: true,
          ticks: { precision: 0, font: { size: 12 } },
          grid: { color: '#eeeeee' },
        },
        y: {
          ticks: { font: { size: 14, weight: 'bold' } },
          grid: { display: false },
        },
      },
      layout: { padding: { right: 40 } },
    },
  };

  return postChart(chart, 600, 320);
}

export async function renderRoleStackedChart(
  buckets: RoleBucket[],
  title: string,
): Promise<Buffer | null> {
  const filtered = buckets.filter((b) => b.blocked + b.delayed > 0);
  if (filtered.length === 0) return null;

  // Sort by total desc so the busiest owner is leftmost.
  filtered.sort((a, b) => b.blocked + b.delayed - (a.blocked + a.delayed));

  const labels = filtered.map((b) => b.label);
  // Map 0 → null so chartjs-plugin-datalabels skips the label for that stack
  // segment (it would otherwise render a "0" on top of the other segment).
  const blockedData = filtered.map((b) => (b.blocked > 0 ? b.blocked : null));
  const delayedData = filtered.map((b) => (b.delayed > 0 ? b.delayed : null));

  // Dynamic width so labels don't crowd when there are many owners.
  const width = Math.max(640, 90 * filtered.length + 120);

  const chart = {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Blocked',
          data: blockedData,
          backgroundColor: '#d93025',
          borderColor: '#a50e0e',
          borderWidth: 1,
          stack: 'status',
        },
        {
          label: 'Delayed',
          data: delayedData,
          backgroundColor: '#f4b400',
          borderColor: '#c08400',
          borderWidth: 1,
          stack: 'status',
        },
      ],
    },
    options: {
      plugins: {
        legend: { position: 'top', labels: { font: { size: 12 } } },
        title: {
          display: true,
          text: title,
          font: { size: 16, weight: 'bold' },
          padding: { top: 6, bottom: 12 },
        },
        datalabels: {
          color: '#ffffff',
          font: { size: 11, weight: 'bold' },
        },
      },
      scales: {
        x: {
          stacked: true,
          ticks: { font: { size: 11 }, maxRotation: 45, minRotation: 30 },
          grid: { display: false },
        },
        y: {
          stacked: true,
          beginAtZero: true,
          ticks: { precision: 0, font: { size: 12 } },
          grid: { color: '#eeeeee' },
          title: { display: true, text: 'Projects', font: { size: 12 } },
        },
      },
    },
  };

  return postChart(chart, width, 380);
}
