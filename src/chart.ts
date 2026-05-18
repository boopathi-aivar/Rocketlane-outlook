import axios from 'axios';

const QUICKCHART_URL = 'https://quickchart.io/chart';

export async function renderSummaryChart(
  blocked: number,
  delayed: number,
): Promise<Buffer | null> {
  const total = blocked + delayed;
  if (total === 0) return null;

  const chart = {
    type: 'doughnut',
    data: {
      labels: [`Blocked (${blocked})`, `Delayed (${delayed})`],
      datasets: [
        {
          data: [blocked, delayed],
          backgroundColor: ['#d93025', '#f4b400'],
          borderColor: '#ffffff',
          borderWidth: 2,
        },
      ],
    },
    options: {
      plugins: {
        legend: { position: 'bottom', labels: { font: { size: 14 } } },
        title: {
          display: true,
          text: `${total} project${total === 1 ? '' : 's'} requiring attention`,
          font: { size: 16, weight: 'bold' },
        },
      },
    },
  };

  try {
    const { data } = await axios.post(
      QUICKCHART_URL,
      {
        chart,
        width: 600,
        height: 320,
        backgroundColor: 'white',
        format: 'png',
      },
      { responseType: 'arraybuffer', timeout: 15000 },
    );
    return Buffer.from(data);
  } catch (err) {
    console.warn('Chart render failed, falling back to text summary', err);
    return null;
  }
}
