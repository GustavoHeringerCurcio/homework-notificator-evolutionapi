import { Homework } from './types';

export function generateMockHomeworks(seedDate: string): Homework[] {
  const base = new Date(seedDate);

  const entries: { title: string; offsetDays: number }[] = [
    { title: 'Lista de exercícios - Cálculo I', offsetDays: 2 },
    { title: 'Projeto final - Estrutura de Dados', offsetDays: 3 },
    { title: 'Relatório de laboratório - Física II', offsetDays: 5 },
    { title: 'Leitura complementar - Programação', offsetDays: 7 },
  ];

  return entries.map(({ title, offsetDays }) => {
    const dueDate = new Date(base);
    dueDate.setDate(dueDate.getDate() + offsetDays);
    return {
      title,
      due_date: formatDate(dueDate),
      due_time: '23:59',
    };
  });
}

export function generateMockFreshEntry(): Homework {
  const now = new Date();
  const dueDate = new Date(now);
  dueDate.setDate(dueDate.getDate() + 2);
  return {
    title: `Tarefa extra - ${now.toISOString().slice(0, 10)}`,
    due_date: formatDate(dueDate),
    due_time: '23:59',
  };
}

export function generateMockNewSemester(): Homework[] {
  const now = new Date();
  const entries: { title: string; offsetDays: number }[] = [
    { title: 'Lista 1 - Álgebra Linear', offsetDays: 3 },
    { title: 'Projeto - Banco de Dados', offsetDays: 5 },
    { title: 'Seminário - Redes de Computadores', offsetDays: 7 },
    { title: 'Exercícios - Probabilidade', offsetDays: 2 },
    { title: 'Trabalho final - Engenharia de Software', offsetDays: 10 },
  ];

  return entries.map(({ title, offsetDays }) => {
    const dueDate = new Date(now);
    dueDate.setDate(dueDate.getDate() + offsetDays);
    return {
      title,
      due_date: formatDate(dueDate),
      due_time: '23:59',
    };
  });
}

function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
