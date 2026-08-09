import { Config } from './types';
import { logger } from './logger';

export async function checkEvolutionApi(config: Config): Promise<{ reachable: boolean; instanceConnected: boolean }> {
  try {
    const url = `${config.evolutionApiUrl}/instance/connect/${config.evolutionInstance}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: { apikey: config.evolutionApiKey },
    });

    if (!response.ok) {
      logger.warn('Evolution API returned non-OK response', { status: response.status });
      return { reachable: true, instanceConnected: false };
    }

    const data = (await response.json()) as { instance?: { state?: string } };
    const connected = data?.instance?.state === 'open';
    return { reachable: true, instanceConnected: connected };
  } catch (err) {
    logger.warn('Evolution API unreachable', { error: String(err) });
    return { reachable: false, instanceConnected: false };
  }
}

export async function sendNotification(
  number: string,
  text: string,
  config: Config,
): Promise<{ success: boolean; error?: string; statusCode?: number }> {
  if (config.dryRun) {
    logger.info(`[DRY RUN] Would send to ${number}: ${text.slice(0, 80)}...`);
    return { success: true };
  }

  try {
    const url = `${config.evolutionApiUrl}/message/sendText/${config.evolutionInstance}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: config.evolutionApiKey,
      },
      body: JSON.stringify({ number, text }),
    });

    if (!response.ok) {
      const body = await response.text();
      return { success: false, error: body, statusCode: response.status };
    }

    return { success: true, statusCode: response.status };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

export async function notifyForHomework(
  title: string,
  dueDate: string,
  dueTime: string | null,
  config: Config,
): Promise<number> {
  const formattedDate = formatDatePtBr(dueDate);
  const timeStr = dueTime ? `\n⏰ Horário: ${dueTime}` : '';
  const message = [
    '📚 *Nova tarefa*',
    '',
    `*${title}*`,
    `📅 Entrega: ${formattedDate}${timeStr}`,
    '',
    `🔗 ${config.collegeHomeworkUrl}`,
  ].join('\n');

  const truncated = message.length > 4096
    ? message.slice(0, 4093) + '...'
    : message;

  let sentCount = 0;
  for (const number of config.notifyNumbers) {
    const result = await sendNotification(number, truncated, config);
    if (result.success) {
      sentCount++;
    } else {
      logger.warn('Failed to notify number', { number, error: result.error });
    }
  }

  return sentCount;
}

function formatDatePtBr(dateStr: string): string {
  try {
    const date = new Date(dateStr + 'T12:00:00');
    const months = [
      'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
      'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro',
    ];
    return `${date.getDate()} de ${months[date.getMonth()]} de ${date.getFullYear()}`;
  } catch {
    return dateStr;
  }
}
