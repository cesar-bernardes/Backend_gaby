require('dotenv').config();

const express = require('express');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { randomUUID } = require('crypto');

const app = express();
const PORT = Number(process.env.PORT || 5000);
const SECRET_KEY = process.env.JWT_SECRET || 'troque_esta_chave_no_arquivo_env';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_SCHEMA = process.env.SUPABASE_SCHEMA || 'Studio';

const allowedOrigins = (process.env.CLIENT_URLS || process.env.CLIENT_URL || 'http://localhost:3000,http://localhost:5173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const supabase = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  })
  : null;

app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error(`Origem nao permitida pelo CORS: ${origin}`));
  },
  credentials: true,
}));

const now = () => new Date().toISOString();
const makeId = (prefix) => `${prefix}_${randomUUID()}`;
const onlyDigits = (value = '') => String(value).replace(/\D/g, '');
const isDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
const isTime = (value) => /^\d{2}:\d{2}$/.test(String(value || ''));
const normalizeRole = (role) => (role === 'ADMIN' || role === 'ADM' ? 'ADM' : 'CLIENT');
const isAdminRole = (role) => normalizeRole(role) === 'ADM';
const activeAppointmentStatuses = ['PENDING', 'CONFIRMED', 'DONE'];
const editableAppointmentStatuses = ['PENDING', 'CONFIRMED'];

const timeToMinutes = (time) => {
  const [hours, minutes] = String(time || '00:00').split(':').map(Number);
  return (hours * 60) + minutes;
};

const minutesToTime = (minutes) => {
  const normalized = Math.max(0, minutes);
  const hours = Math.floor(normalized / 60);
  const rest = normalized % 60;
  return `${String(hours).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
};

const addMinutes = (time, minutes) => minutesToTime(timeToMinutes(time) + Number(minutes || 0));
const intervalsOverlap = (leftStart, leftEnd, rightStart, rightEnd) => (
  timeToMinutes(leftStart) < timeToMinutes(rightEnd)
  && timeToMinutes(leftEnd) > timeToMinutes(rightStart)
);
const dateWeekday = (date) => {
  const [year, month, day] = String(date).split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
};

const defaultSchedulePolicy = {
  defaultWorkDays: [1, 2, 3, 4, 5, 6],
  defaultStartTime: '07:00',
  defaultEndTime: '17:00',
  sundayEnabled: false,
  slotIntervalMinutes: 30,
};

const getSchedulePolicy = (studio) => ({
  ...defaultSchedulePolicy,
  ...(studio?.policy || {}),
  defaultWorkDays: Array.isArray(studio?.policy?.defaultWorkDays)
    ? studio.policy.defaultWorkDays.map(Number)
    : defaultSchedulePolicy.defaultWorkDays,
});

const isDefaultWorkDate = (date, policy) => {
  const weekday = dateWeekday(date);
  if (weekday === 0 && !policy.sundayEnabled) return false;
  return policy.defaultWorkDays.includes(weekday);
};

const blockAppliesToDate = (block, date) => (
  block.date === date
  || (
    block.recurrence === 'WEEKLY'
    && Number(block.weekday) === dateWeekday(date)
    && String(block.date || '') <= date
  )
);

const asyncHandler = (handler) => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next);
};

const toCents = (value) => {
  if (typeof value === 'number') return Math.round(value * 100);
  const normalized = String(value || '').replace(/\./g, '').replace(',', '.');
  const number = Number(normalized);
  return Number.isFinite(number) ? Math.round(number * 100) : null;
};

const formatPrice = (cents = 0) => (Number(cents || 0) / 100).toFixed(2);

const durationLabel = (minutes) => {
  const total = Number(minutes || 0);
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (hours && rest) return `${hours}h${String(rest).padStart(2, '0')}`;
  if (hours) return `${hours}h`;
  return `${rest}min`;
};

const assertSupabase = () => {
  if (supabase) return;

  const error = new Error('Configure SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no arquivo .env antes de iniciar o backend.');
  error.statusCode = 500;
  throw error;
};

const db = () => {
  assertSupabase();
  return supabase.schema(SUPABASE_SCHEMA);
};

const schemaMissingMessage = `O schema ${SUPABASE_SCHEMA} do Supabase esta incompleto. Rode Backend/supabase/schema.sql no SQL Editor do Supabase e aguarde a Data API recarregar o schema.`;
const schemaErrorCodes = new Set(['PGRST106', 'PGRST205', '42703', '42P01']);

const runQuery = async (query) => {
  assertSupabase();
  const result = query && typeof query.execute === 'function' ? await query.execute() : await query;
  const { data, error } = result || {};
  if (error) {
    if (schemaErrorCodes.has(error.code)) {
      const wrappedError = new Error(schemaMissingMessage);
      wrappedError.statusCode = 500;
      wrappedError.cause = error;
      throw wrappedError;
    }

    error.statusCode = error.code === 'PGRST116' ? 404 : 500;
    throw error;
  }
  return data;
};

const publicUser = (user) => user && ({
  id: user.id,
  name: user.name,
  phone: user.phone,
  role: normalizeRole(user.role),
});

const mapService = (row) => row && ({
  id: row.id,
  name: row.name,
  nome: row.name,
  description: row.description || '',
  descricao: row.description || '',
  priceCents: row.price_cents,
  preco: Number(row.price_cents || 0) / 100,
  durationMinutes: row.duration_minutes,
  duracao: durationLabel(row.duration_minutes),
  category: row.category || 'moment',
  sortOrder: row.sort_order,
  active: row.active,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const mapAppointment = (row, service = null) => row && ({
  id: row.id,
  userId: row.user_id,
  clientName: row.client_name,
  clientPhone: row.client_phone,
  serviceId: row.service_id,
  serviceName: row.service_name,
  date: row.date,
  time: row.time,
  startTime: row.start_time || row.time,
  endTime: row.end_time || row.time,
  status: row.status,
  notes: row.notes || '',
  totalCents: row.total_cents,
  depositCents: row.deposit_cents,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  service: service ? mapService(service) : null,
});

const mapFeedPost = (row) => row && ({
  id: row.id,
  title: row.title,
  subtitle: row.subtitle || '',
  content: row.content || [],
  footer: row.footer || '',
  sortOrder: row.sort_order,
  active: row.active,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const mapPackage = (row) => row && ({
  id: row.id,
  promotionId: row.promotion_id,
  name: row.name,
  nome: row.name,
  priceCents: row.price_cents,
  preco: formatPrice(row.price_cents).replace('.', ','),
  subtitle: row.subtitle || '',
  subtitulo: row.subtitle || '',
  benefits: row.benefits || [],
  beneficios: row.benefits || [],
  sortOrder: row.sort_order,
  active: row.active,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const mapPromotion = (row, packages = []) => row && ({
  id: row.id,
  title: row.title,
  type: row.type,
  active: row.active,
  packages: packages.map(mapPackage),
  pacotes: packages.map(mapPackage),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const mapStudio = (row) => row && ({
  id: row.id,
  name: row.name,
  address: row.address,
  city: row.city,
  state: row.state,
  whatsapp: row.whatsapp || '',
  instagram: row.instagram || '',
  policy: row.policy || {},
  updatedAt: row.updated_at,
});

const mapAvailabilityDate = (row) => row && ({
  date: row.date,
  startTime: row.start_time,
  endTime: row.end_time,
  active: row.active !== false,
  slots: row.slots || [],
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const mapAvailabilityBlock = (row) => row && ({
  id: row.id,
  date: row.date,
  startTime: row.start_time,
  endTime: row.end_time,
  fullDay: row.full_day === true,
  recurrence: row.recurrence || 'NONE',
  weekday: row.weekday ?? null,
  reason: row.reason || '',
  createdBy: row.created_by || null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const defaultStudio = () => ({
  id: 'main',
  name: 'Gabriely Dias Nail Designer',
  address: 'Rua Oliveira Marques, 5168',
  city: 'Dourados',
  state: 'Mato Grosso do Sul',
  whatsapp: '',
  instagram: '',
  policy: {
    depositPercent: 40,
    delayToleranceMinutes: 15,
    cancellationWindowHours: 24,
    maxCompanions: 1,
    defaultWorkDays: [1, 2, 3, 4, 5, 6],
    defaultStartTime: '07:00',
    defaultEndTime: '17:00',
    sundayEnabled: false,
    slotIntervalMinutes: 30,
  },
});

const seedServices = [
  { id: 'srv_alongamento_f1', name: 'Alongamento Molde F1', description: '', category: 'moment', price_cents: 10000, duration_minutes: 80, sort_order: 1, active: true },
  { id: 'srv_manutencao_30', name: 'Manutencao (30 dias)', description: '', category: 'moment', price_cents: 9000, duration_minutes: 60, sort_order: 2, active: true },
  { id: 'srv_blindagem', name: 'Blindagem', description: '', category: 'moment', price_cents: 5500, duration_minutes: 40, sort_order: 3, active: true },
  { id: 'srv_esmalte_gel', name: 'Esmaltacao em Gel', description: '', category: 'moment', price_cents: 6000, duration_minutes: 40, sort_order: 4, active: true },
  { id: 'srv_pedicure_gel', name: 'Pedicure em Gel', description: '', category: 'moment', price_cents: 6500, duration_minutes: 50, sort_order: 5, active: true },
  { id: 'srv_plano_alongamento_premium', name: 'Plano Premium Alongamento', description: 'Pacote mensal de alongamento', category: 'monthly', price_cents: 19990, duration_minutes: 90, sort_order: 101, active: true },
  { id: 'srv_plano_alongamento_gold', name: 'Plano Gold Alongamento', description: 'Pacote mensal de alongamento', category: 'monthly', price_cents: 17990, duration_minutes: 80, sort_order: 102, active: true },
  { id: 'srv_plano_alongamento_star', name: 'Plano Star Alongamento', description: 'Pacote mensal de alongamento', category: 'monthly', price_cents: 16990, duration_minutes: 70, sort_order: 103, active: true },
  { id: 'srv_plano_banho_gel_premium', name: 'Plano Premium Banho de Gel', description: 'Pacote mensal de banho de gel', category: 'monthly', price_cents: 12990, duration_minutes: 70, sort_order: 104, active: true },
  { id: 'srv_plano_banho_gel_gold', name: 'Plano Gold Banho de Gel', description: 'Pacote mensal de banho de gel', category: 'monthly', price_cents: 11990, duration_minutes: 60, sort_order: 105, active: true },
];

const seedFeedPosts = [
  {
    id: 'post_tecnicas',
    title: 'TECNICAS',
    subtitle: 'Conheca nossos procedimentos',
    sort_order: 1,
    active: true,
    content: [
      { label: 'ALONGAMENTO NO MOLDE F1', desc: 'Acabamento natural e sofisticado, com longa duracao. Durabilidade de 25 a 30 dias.' },
      { label: 'BANHO DE GEL', desc: 'Mantem as unhas naturais resistentes. Uma fina camada de gel em toda a unha natural. Durabilidade de 20 a 30 dias.' },
      { label: 'ESMALTACAO EM GEL', desc: 'Ideal para unhas naturais resistentes, com durabilidade maior que uma esmaltacao tradicional.' },
    ],
    footer: 'A durabilidade depende do cuidado da cliente e saude das unhas.',
  },
  {
    id: 'post_sinal',
    title: 'ATRASO E SINAL',
    subtitle: 'Politicas do Estudio',
    sort_order: 2,
    active: true,
    content: [
      { label: 'SINAL DE 40%', desc: 'Cobrado no ato do agendamento para confirmacao. Sera abatido do valor final.' },
      { label: 'TOLERANCIA (15 MINUTOS)', desc: 'Depois da tolerancia, decoracoes elaboradas podem ser ajustadas para nao atrasar a proxima cliente.' },
      { label: 'CANCELAMENTOS (< 24H)', desc: 'Sem reembolso do sinal. O valor pode ser usado em um reagendamento, sujeito a disponibilidade.' },
    ],
    footer: 'Amparado pela Lei 10.406, Codigo Civil (Art. 417 a 420) e CDC.',
  },
];

const seedPromotions = [
  { id: 'promo_alongamento', title: 'Pacotes Mensais Alongamento', type: 'alongamento', active: true },
  { id: 'promo_banho_gel', title: 'Pacotes Mensais Banho de Gel', type: 'banho_gel', active: true },
];

const seedPromotionPackages = [
  {
    id: 'pkg_alongamento_premium',
    promotion_id: 'promo_alongamento',
    name: 'Premium',
    price_cents: 19990,
    subtitle: '2 manutencoes em 30 dias corridos',
    benefits: ['Manutencao completa', 'Esmaltacao em gel tradicional', 'Francesinha', 'Todo tipo de nail art', 'Pedrarias e pingentes', 'Cutilagem', 'Baby boomer', 'Reposicao de unhas quebradas'],
    sort_order: 1,
    active: true,
  },
  {
    id: 'pkg_alongamento_gold',
    promotion_id: 'promo_alongamento',
    name: 'Gold',
    price_cents: 17990,
    subtitle: '2 manutencoes em 30 dias corridos',
    benefits: ['Manutencao completa', 'Esmaltacao em gel tradicional', 'Francesinha', 'Todo tipo de nail art', 'Cutilagem'],
    sort_order: 2,
    active: true,
  },
  {
    id: 'pkg_alongamento_star',
    promotion_id: 'promo_alongamento',
    name: 'Star',
    price_cents: 16990,
    subtitle: '2 manutencoes em 30 dias corridos',
    benefits: ['Manutencao completa', 'Esmaltacao em gel tradicional', 'Francesinha', 'Cutilagem'],
    sort_order: 3,
    active: true,
  },
  {
    id: 'pkg_banho_gel_premium',
    promotion_id: 'promo_banho_gel',
    name: 'Premium',
    price_cents: 12990,
    subtitle: '2 banhos de gel em 30 dias corridos',
    benefits: ['Banho de gel completo', 'Esmaltacao em gel tradicional', 'Francesinha', 'Todo tipo de nail art', 'Cutilagem'],
    sort_order: 1,
    active: true,
  },
  {
    id: 'pkg_banho_gel_gold',
    promotion_id: 'promo_banho_gel',
    name: 'Gold',
    price_cents: 11990,
    subtitle: '2 banhos de gel em 30 dias corridos',
    benefits: ['Banho de gel completo', 'Esmaltacao em gel tradicional', 'Francesinha', 'Cutilagem'],
    sort_order: 2,
    active: true,
  },
];

const tableMissingMessage = `As tabelas do Supabase nao foram encontradas no schema ${SUPABASE_SCHEMA}. Rode Backend/supabase/schema.sql no SQL Editor do Supabase e exponha esse schema na API.`;

const ensureSchemaReady = async () => {
  const checks = [
    db().from('studio_settings').select('id').limit(1),
    db().from('app_users').select('id,role').limit(1),
    db().from('services').select('id,description,category,duration_minutes').limit(1),
    db().from('availability_blocks').select('id,date,start_time,end_time,full_day,recurrence,weekday,reason').limit(1),
    db().from('appointments').select('id,start_time,end_time,status').limit(1),
  ];

  for (const check of checks) {
    await runQuery(check);
  }
};

const ensureSeedData = async () => {
  assertSupabase();
  await ensureSchemaReady();

  const { data: studio, error: studioError } = await db()
    .from('studio_settings')
    .select('id')
    .eq('id', 'main')
    .maybeSingle();

  if (studioError) {
    const error = new Error(tableMissingMessage);
    error.cause = studioError;
    throw error;
  }

  if (!studio) {
    await runQuery(db().from('studio_settings').insert(defaultStudio()));
  }

  const { data: services, error: servicesError } = await db()
    .from('services')
    .select('id')
    .limit(1000);

  if (servicesError) throw servicesError;
  const existingServiceIds = new Set(services.map((service) => service.id));
  const missingServices = seedServices.filter((service) => !existingServiceIds.has(service.id));
  if (missingServices.length) await runQuery(db().from('services').insert(missingServices));

  const { data: posts, error: postsError } = await db()
    .from('feed_posts')
    .select('id')
    .limit(1);

  if (postsError) throw postsError;
  if (!posts.length) await runQuery(db().from('feed_posts').insert(seedFeedPosts));

  const { data: promotions, error: promotionsError } = await db()
    .from('promotions')
    .select('id')
    .limit(1);

  if (promotionsError) throw promotionsError;
  if (!promotions.length) {
    await runQuery(db().from('promotions').insert(seedPromotions));
    await runQuery(db().from('promotion_packages').insert(seedPromotionPackages));
  }
};

const getStudio = async () => {
  const row = await runQuery(db()
    .from('studio_settings')
    .select('*')
    .eq('id', 'main')
    .maybeSingle());

  return mapStudio(row || defaultStudio());
};

const findUserByPhone = async (phone) => runQuery(db()
  .from('app_users')
  .select('*')
  .eq('phone', onlyDigits(phone))
  .maybeSingle());

const findUserById = async (id) => runQuery(db()
  .from('app_users')
  .select('*')
  .eq('id', id)
  .maybeSingle());

const upsertUser = async ({ phone, name, role = 'CLIENT' }) => {
  const normalizedPhone = onlyDigits(phone);
  const existing = await findUserByPhone(normalizedPhone);
  const finalRole = normalizeRole(role);

  if (!existing) {
    return runQuery(db()
      .from('app_users')
      .insert({
        id: makeId('usr'),
        name: name || 'Cliente',
        phone: normalizedPhone,
        role: finalRole,
      })
      .select()
      .single());
  }

  const nextRole = isAdminRole(finalRole) ? 'ADM' : normalizeRole(existing.role);
  return runQuery(db()
    .from('app_users')
    .update({
      name: name || existing.name,
      role: nextRole,
      updated_at: now(),
    })
    .eq('id', existing.id)
    .select()
    .single());
};

const authenticate = asyncHandler(async (req, res, next) => {
  const bearerToken = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.slice(7)
    : null;
  const token = req.cookies.auth_token || bearerToken;

  if (!token) return res.status(401).json({ message: 'Nao autorizado' });

  let payload;
  try {
    payload = jwt.verify(token, SECRET_KEY);
  } catch {
    return res.status(403).json({ message: 'Token invalido' });
  }

  const user = await findUserById(payload.id);

  if (!user) return res.status(401).json({ message: 'Usuario nao encontrado' });

  req.user = user;
  return next();
});

const requireAdmin = (req, res, next) => {
  if (!isAdminRole(req.user?.role)) return res.status(403).json({ message: 'Acesso restrito a administracao' });
  return next();
};

const getServices = async ({ includeInactive = false } = {}) => {
  let query = db()
    .from('services')
    .select('*')
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true });

  if (!includeInactive) query = query.neq('active', false);

  const rows = await runQuery(query);
  return rows.map(mapService);
};

const findService = async (serviceId) => {
  const row = await runQuery(db()
    .from('services')
    .select('*')
    .eq('id', serviceId)
    .neq('active', false)
    .maybeSingle());

  return row;
};

const findAppointmentById = async (appointmentId) => runQuery(db()
  .from('appointments')
  .select('*')
  .eq('id', appointmentId)
  .maybeSingle());

const canManageAppointment = (user, appointment) => (
  isAdminRole(user?.role)
  || appointment?.user_id === user?.id
  || appointment?.client_phone === user?.phone
);

const getSlotsForDate = async (date, serviceId = null, options = {}) => {
  const studio = await getStudio();
  const policy = getSchedulePolicy(studio);

  const service = serviceId ? await findService(serviceId) : null;
  if (serviceId && !service) return [];
  const durationMinutes = Number(service?.duration_minutes || studio.policy?.defaultSlotDurationMinutes || 30);
  const slotIntervalMinutes = Number(policy.slotIntervalMinutes || 30);
  const dayStart = policy.defaultStartTime;
  const dayEnd = policy.defaultEndTime;

  if (!isDefaultWorkDate(date, policy)) {
    return [];
  }

  const [appointments, allBlocks] = await Promise.all([
    runQuery(db()
      .from('appointments')
      .select('id,time,start_time,end_time,status,service_id')
      .eq('date', date)),
    runQuery(db()
      .from('availability_blocks')
      .select('*')),
  ]);
  const blocks = allBlocks.filter((block) => blockAppliesToDate(block, date));
  if (blocks.some((block) => block.full_day === true)) return [];

  const appointmentServicesById = await getServicesByIds([...new Set(appointments.map((appointment) => appointment.service_id).filter(Boolean))]);

  const busyIntervals = [
    ...blocks.map((block) => ({
      start: block.start_time || dayStart,
      end: block.end_time || dayEnd,
      type: 'block',
      reason: block.reason || '',
    })),
    ...appointments
      .filter((appointment) => (
        appointment.id !== options.ignoreAppointmentId
        && activeAppointmentStatuses.includes(appointment.status)
      ))
      .map((appointment) => {
        const start = appointment.start_time || appointment.time;
        const serviceDuration = Number(appointmentServicesById.get(appointment.service_id)?.duration_minutes || durationMinutes);
        const end = appointment.end_time && timeToMinutes(appointment.end_time) > timeToMinutes(start)
          ? appointment.end_time
          : addMinutes(start, serviceDuration);

        return {
          start,
          end,
          type: 'appointment',
        };
      }),
  ];

  const slots = [];
  for (let current = timeToMinutes(dayStart); current + durationMinutes <= timeToMinutes(dayEnd); current += slotIntervalMinutes) {
    const start = minutesToTime(current);
    const end = minutesToTime(current + durationMinutes);
    const conflict = busyIntervals.find((interval) => intervalsOverlap(start, end, interval.start, interval.end));

    slots.push({
      time: start,
      startTime: start,
      endTime: end,
      active: true,
      booked: Boolean(conflict),
      available: !conflict,
      conflictType: conflict?.type || null,
    });
  }

  return slots;
};

const getPromotions = async ({ includeInactive = false } = {}) => {
  let promotionQuery = db()
    .from('promotions')
    .select('*')
    .order('created_at', { ascending: true });

  if (!includeInactive) promotionQuery = promotionQuery.neq('active', false);

  const promotions = await runQuery(promotionQuery);
  if (!promotions.length) return [];

  let packageQuery = db()
    .from('promotion_packages')
    .select('*')
    .in('promotion_id', promotions.map((promotion) => promotion.id))
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true });

  if (!includeInactive) packageQuery = packageQuery.neq('active', false);

  const packages = await runQuery(packageQuery);
  const packagesByPromotion = new Map();

  for (const item of packages) {
    const group = packagesByPromotion.get(item.promotion_id) || [];
    group.push(item);
    packagesByPromotion.set(item.promotion_id, group);
  }

  return promotions.map((promotion) => mapPromotion(promotion, packagesByPromotion.get(promotion.id) || []));
};

const findPromotionPackage = async (packageId) => {
  const row = await runQuery(db()
    .from('promotion_packages')
    .select('*, promotions(*)')
    .eq('id', packageId)
    .maybeSingle());

  if (!row) return null;

  return {
    promotion: row.promotions,
    package: row,
  };
};

const getServicesByIds = async (ids) => {
  if (!ids.length) return new Map();
  const rows = await runQuery(db()
    .from('services')
    .select('*')
    .in('id', ids));

  return new Map(rows.map((service) => [service.id, service]));
};

const sendAuthResponse = (res, user) => {
  const token = jwt.sign({ id: user.id, phone: user.phone, role: user.role }, SECRET_KEY, { expiresIn: '7d' });

  res.cookie('auth_token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });

  return res.json({ success: true, user: publicUser(user) });
};

app.get('/api/health', asyncHandler(async (_req, res) => {
  assertSupabase();
  const studio = await getStudio();

  res.json({
    ok: true,
    storage: 'supabase',
    schema: SUPABASE_SCHEMA,
    studio: studio.name,
    updatedAt: studio.updatedAt,
  });
}));

app.get('/api/bootstrap', asyncHandler(async (_req, res) => {
  const [studio, services, feedPosts, promotions] = await Promise.all([
    getStudio(),
    getServices(),
    runQuery(db()
      .from('feed_posts')
      .select('*')
      .neq('active', false)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true })),
    getPromotions(),
  ]);

  res.json({
    studio,
    services,
    feedPosts: feedPosts.map(mapFeedPost),
    promotions,
  });
}));

app.post('/api/auth/check-phone', asyncHandler(async (req, res) => {
  const normalizedPhone = onlyDigits(req.body.phone);

  if (normalizedPhone.length < 10) {
    return res.status(400).json({ message: 'Informe um WhatsApp valido' });
  }

  const user = await findUserByPhone(normalizedPhone);

  return res.json({
    exists: Boolean(user),
    needsRegistration: !user,
    user: user ? publicUser(user) : null,
  });
}));

app.post('/api/login', asyncHandler(async (req, res) => {
  const { phone, role, adminCode } = req.body;
  const normalizedPhone = onlyDigits(phone);

  if (normalizedPhone.length < 10) {
    return res.status(400).json({ message: 'Informe um WhatsApp valido' });
  }

  const existingUser = await findUserByPhone(normalizedPhone);
  if (!existingUser) {
    return res.status(404).json({
      message: 'Cadastro nao encontrado',
      needsRegistration: true,
    });
  }

  const adminByPhone = process.env.ADMIN_PHONE && onlyDigits(process.env.ADMIN_PHONE) === normalizedPhone;
  const adminByCode = process.env.ADMIN_CODE && adminCode === process.env.ADMIN_CODE;
  const requestedAdmin = isAdminRole(role);
  const finalRole = requestedAdmin && (adminByPhone || adminByCode) ? 'ADM' : normalizeRole(existingUser.role);

  const updatedUser = await runQuery(db()
    .from('app_users')
    .update({ role: finalRole, last_login_at: now(), updated_at: now() })
    .eq('id', existingUser.id)
    .select()
    .single());

  return sendAuthResponse(res, updatedUser);
}));

app.post('/api/register', asyncHandler(async (req, res) => {
  const normalizedPhone = onlyDigits(req.body.phone);
  const name = String(req.body.name || '').trim();

  if (normalizedPhone.length < 10) {
    return res.status(400).json({ message: 'Informe um WhatsApp valido' });
  }
  if (name.length < 2) {
    return res.status(400).json({ message: 'Informe seu nome' });
  }

  const existingUser = await findUserByPhone(normalizedPhone);
  if (existingUser) {
    const updatedUser = await runQuery(db()
      .from('app_users')
      .update({ name, last_login_at: now(), updated_at: now() })
      .eq('id', existingUser.id)
      .select()
      .single());

    return sendAuthResponse(res, updatedUser);
  }

  const user = await runQuery(db()
    .from('app_users')
    .insert({
      id: makeId('usr'),
      name,
      phone: normalizedPhone,
      role: 'CLIENT',
      last_login_at: now(),
    })
    .select()
    .single());

  return sendAuthResponse(res, user);
}));

app.post('/api/logout', (_req, res) => {
  res.clearCookie('auth_token');
  res.json({ success: true });
});

app.get('/api/me', authenticate, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

app.get('/api/studio', asyncHandler(async (_req, res) => {
  res.json(await getStudio());
}));

app.put('/api/studio', authenticate, requireAdmin, asyncHandler(async (req, res) => {
  const current = await getStudio();
  const row = await runQuery(db()
    .from('studio_settings')
    .upsert({
      id: 'main',
      name: req.body.name ?? current.name,
      address: req.body.address ?? current.address,
      city: req.body.city ?? current.city,
      state: req.body.state ?? current.state,
      whatsapp: req.body.whatsapp ?? current.whatsapp,
      instagram: req.body.instagram ?? current.instagram,
      policy: {
        ...(current.policy || {}),
        ...(req.body.policy || {}),
      },
      updated_at: now(),
    }, { onConflict: 'id' })
    .select()
    .single());

  res.json(mapStudio(row));
}));

app.get('/api/services', asyncHandler(async (_req, res) => {
  res.json(await getServices());
}));

app.post('/api/services', authenticate, requireAdmin, asyncHandler(async (req, res) => {
  const name = req.body.name || req.body.nome;
  const description = req.body.description || req.body.descricao || '';
  const category = req.body.category || req.body.categoria || 'moment';
  const priceCents = req.body.priceCents ?? toCents(req.body.price ?? req.body.preco);
  const durationMinutes = Number(req.body.durationMinutes || req.body.duracaoMinutos);

  if (!name || !priceCents || !durationMinutes) {
    return res.status(400).json({ message: 'Nome, preco e duracao sao obrigatorios' });
  }

  const services = await getServices({ includeInactive: true });
  const row = await runQuery(db()
    .from('services')
    .insert({
      id: makeId('srv'),
      name,
      description,
      category,
      price_cents: priceCents,
      duration_minutes: durationMinutes,
      sort_order: req.body.sortOrder ?? services.length + 1,
      active: req.body.active !== false,
    })
    .select()
    .single());

  res.status(201).json(mapService(row));
}));

app.put('/api/services/:id', authenticate, requireAdmin, asyncHandler(async (req, res) => {
  const patch = { updated_at: now() };

  if (req.body.name || req.body.nome) patch.name = req.body.name || req.body.nome;
  if (req.body.description !== undefined || req.body.descricao !== undefined) {
    patch.description = req.body.description ?? req.body.descricao;
  }
  if (req.body.category !== undefined || req.body.categoria !== undefined) {
    patch.category = req.body.category ?? req.body.categoria;
  }
  if (req.body.priceCents !== undefined || req.body.price !== undefined || req.body.preco !== undefined) {
    patch.price_cents = req.body.priceCents ?? toCents(req.body.price ?? req.body.preco);
  }
  if (req.body.durationMinutes !== undefined || req.body.duracaoMinutos !== undefined) {
    patch.duration_minutes = Number(req.body.durationMinutes || req.body.duracaoMinutos);
  }
  if (req.body.sortOrder !== undefined) patch.sort_order = Number(req.body.sortOrder);
  if (req.body.active !== undefined) patch.active = Boolean(req.body.active);

  const row = await runQuery(db()
    .from('services')
    .update(patch)
    .eq('id', req.params.id)
    .select()
    .maybeSingle());

  if (!row) return res.status(404).json({ message: 'Servico nao encontrado' });
  return res.json(mapService(row));
}));

app.delete('/api/services/:id', authenticate, requireAdmin, asyncHandler(async (req, res) => {
  const row = await runQuery(db()
    .from('services')
    .update({ active: false, updated_at: now() })
    .eq('id', req.params.id)
    .select()
    .maybeSingle());

  if (!row) return res.status(404).json({ message: 'Servico nao encontrado' });
  return res.json({ success: true, service: mapService(row) });
}));

app.get('/api/admin/users', authenticate, requireAdmin, asyncHandler(async (_req, res) => {
  const users = await runQuery(db()
    .from('app_users')
    .select('*')
    .order('created_at', { ascending: false }));

  res.json(users.map(publicUser));
}));

app.patch('/api/admin/users/:id/role', authenticate, requireAdmin, asyncHandler(async (req, res) => {
  const role = normalizeRole(req.body.role);
  const row = await runQuery(db()
    .from('app_users')
    .update({ role, updated_at: now() })
    .eq('id', req.params.id)
    .select()
    .maybeSingle());

  if (!row) return res.status(404).json({ message: 'Usuario nao encontrado' });
  return res.json(publicUser(row));
}));

app.get('/api/admin/services', authenticate, requireAdmin, asyncHandler(async (_req, res) => {
  res.json(await getServices({ includeInactive: true }));
}));

app.post('/api/admin/services', authenticate, requireAdmin, asyncHandler(async (req, res) => {
  const name = req.body.name || req.body.nome;
  const description = req.body.description || req.body.descricao || '';
  const category = req.body.category || req.body.categoria || 'moment';
  const priceCents = req.body.priceCents ?? toCents(req.body.price ?? req.body.preco);
  const durationMinutes = Number(req.body.durationMinutes || req.body.duracaoMinutos);

  if (!name || !priceCents || !durationMinutes) {
    return res.status(400).json({ message: 'Nome, preco e duracao sao obrigatorios' });
  }

  const services = await getServices({ includeInactive: true });
  const row = await runQuery(db()
    .from('services')
    .insert({
      id: makeId('srv'),
      name,
      description,
      category,
      price_cents: priceCents,
      duration_minutes: durationMinutes,
      sort_order: req.body.sortOrder ?? services.length + 1,
      active: req.body.active !== false,
    })
    .select()
    .single());

  res.status(201).json(mapService(row));
}));

app.put('/api/admin/services/:id', authenticate, requireAdmin, asyncHandler(async (req, res) => {
  const patch = { updated_at: now() };

  if (req.body.name || req.body.nome) patch.name = req.body.name || req.body.nome;
  if (req.body.description !== undefined || req.body.descricao !== undefined) patch.description = req.body.description ?? req.body.descricao;
  if (req.body.category !== undefined || req.body.categoria !== undefined) patch.category = req.body.category ?? req.body.categoria;
  if (req.body.priceCents !== undefined || req.body.price !== undefined || req.body.preco !== undefined) {
    patch.price_cents = req.body.priceCents ?? toCents(req.body.price ?? req.body.preco);
  }
  if (req.body.durationMinutes !== undefined || req.body.duracaoMinutos !== undefined) {
    patch.duration_minutes = Number(req.body.durationMinutes || req.body.duracaoMinutos);
  }
  if (req.body.sortOrder !== undefined) patch.sort_order = Number(req.body.sortOrder);
  if (req.body.active !== undefined) patch.active = Boolean(req.body.active);

  const row = await runQuery(db()
    .from('services')
    .update(patch)
    .eq('id', req.params.id)
    .select()
    .maybeSingle());

  if (!row) return res.status(404).json({ message: 'Servico nao encontrado' });
  return res.json(mapService(row));
}));

app.delete('/api/admin/services/:id', authenticate, requireAdmin, asyncHandler(async (req, res) => {
  const row = await runQuery(db()
    .from('services')
    .update({ active: false, updated_at: now() })
    .eq('id', req.params.id)
    .select()
    .maybeSingle());

  if (!row) return res.status(404).json({ message: 'Servico nao encontrado' });
  return res.json({ success: true, service: mapService(row) });
}));

app.get('/api/availability', asyncHandler(async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const serviceId = req.query.serviceId || req.query.servicoId || null;
  if (!isDate(date)) return res.status(400).json({ message: 'Data invalida. Use AAAA-MM-DD.' });

  res.json({ date, serviceId, slots: await getSlotsForDate(date, serviceId) });
}));

app.post('/api/availability', authenticate, requireAdmin, asyncHandler(async (req, res) => {
  const { date } = req.body;
  const startTime = req.body.startTime || req.body.start_time || req.body.inicio || '09:00';
  const endTime = req.body.endTime || req.body.end_time || req.body.fim || '17:00';

  if (!isDate(date)) return res.status(400).json({ message: 'Data invalida. Use AAAA-MM-DD.' });
  if (!isTime(startTime) || !isTime(endTime) || timeToMinutes(startTime) >= timeToMinutes(endTime)) {
    return res.status(400).json({ message: 'Informe inicio e fim validos no formato HH:mm' });
  }

  const row = await runQuery(db()
    .from('availability_dates')
    .upsert({
      date,
      start_time: startTime,
      end_time: endTime,
      active: req.body.active !== false,
      slots: [],
      updated_at: now(),
    }, { onConflict: 'date' })
    .select()
    .single());

  res.json(mapAvailabilityDate(row));
}));

app.delete('/api/availability/:date', authenticate, requireAdmin, asyncHandler(async (req, res) => {
  const { date } = req.params;
  if (!isDate(date)) return res.status(400).json({ message: 'Data invalida. Use AAAA-MM-DD.' });

  await runQuery(db().from('availability_dates').delete().eq('date', date));
  return res.json({ success: true });
}));

app.get('/api/admin/availability', authenticate, requireAdmin, asyncHandler(async (req, res) => {
  const studio = await getStudio();
  const policy = getSchedulePolicy(studio);

  let blockQuery = db()
    .from('availability_blocks')
    .select('*')
    .order('date', { ascending: true })
    .order('start_time', { ascending: true });

  if (req.query.from) blockQuery = blockQuery.gte('date', req.query.from);
  if (req.query.to) blockQuery = blockQuery.lte('date', req.query.to);

  const blocks = await runQuery(blockQuery);

  res.json({
    defaultSchedule: {
      workDays: policy.defaultWorkDays,
      startTime: policy.defaultStartTime,
      endTime: policy.defaultEndTime,
      sundayEnabled: policy.sundayEnabled === true,
      slotIntervalMinutes: policy.slotIntervalMinutes,
    },
    dates: [],
    blocks: blocks.map(mapAvailabilityBlock),
  });
}));

app.post('/api/admin/availability', authenticate, requireAdmin, asyncHandler(async (req, res) => {
  const { date } = req.body;
  const startTime = req.body.startTime || req.body.start_time || '09:00';
  const endTime = req.body.endTime || req.body.end_time || '17:00';

  if (!isDate(date)) return res.status(400).json({ message: 'Data invalida. Use AAAA-MM-DD.' });
  if (!isTime(startTime) || !isTime(endTime) || timeToMinutes(startTime) >= timeToMinutes(endTime)) {
    return res.status(400).json({ message: 'Informe inicio e fim validos no formato HH:mm' });
  }

  const row = await runQuery(db()
    .from('availability_dates')
    .upsert({
      date,
      start_time: startTime,
      end_time: endTime,
      active: req.body.active !== false,
      slots: [],
      updated_at: now(),
    }, { onConflict: 'date' })
    .select()
    .single());

  res.json(mapAvailabilityDate(row));
}));

app.put('/api/admin/availability/:date', authenticate, requireAdmin, asyncHandler(async (req, res) => {
  const { date } = req.params;
  const patch = { updated_at: now() };

  if (!isDate(date)) return res.status(400).json({ message: 'Data invalida. Use AAAA-MM-DD.' });
  if (req.body.startTime || req.body.start_time) patch.start_time = req.body.startTime || req.body.start_time;
  if (req.body.endTime || req.body.end_time) patch.end_time = req.body.endTime || req.body.end_time;
  if (req.body.active !== undefined) patch.active = Boolean(req.body.active);
  if ((patch.start_time && !isTime(patch.start_time)) || (patch.end_time && !isTime(patch.end_time))) {
    return res.status(400).json({ message: 'Horarios invalidos' });
  }

  const row = await runQuery(db()
    .from('availability_dates')
    .update(patch)
    .eq('date', date)
    .select()
    .maybeSingle());

  if (!row) return res.status(404).json({ message: 'Disponibilidade nao encontrada' });
  return res.json(mapAvailabilityDate(row));
}));

app.delete('/api/admin/availability/:date', authenticate, requireAdmin, asyncHandler(async (req, res) => {
  const { date } = req.params;
  if (!isDate(date)) return res.status(400).json({ message: 'Data invalida. Use AAAA-MM-DD.' });

  await runQuery(db().from('availability_dates').delete().eq('date', date));
  return res.json({ success: true });
}));

app.post('/api/admin/availability-blocks', authenticate, requireAdmin, asyncHandler(async (req, res) => {
  const { date } = req.body;
  const policy = getSchedulePolicy(await getStudio());
  const fullDay = req.body.fullDay === true || req.body.full_day === true;
  const repeatWeekly = req.body.repeatWeekly === true || req.body.recurrence === 'WEEKLY';
  const startTime = fullDay
    ? policy.defaultStartTime
    : (req.body.startTime || req.body.start_time);
  const endTime = fullDay
    ? policy.defaultEndTime
    : (req.body.endTime || req.body.end_time);

  if (!isDate(date)) return res.status(400).json({ message: 'Data invalida. Use AAAA-MM-DD.' });
  if (!isTime(startTime) || !isTime(endTime) || timeToMinutes(startTime) >= timeToMinutes(endTime)) {
    return res.status(400).json({ message: 'Informe inicio e fim validos no formato HH:mm' });
  }

  const row = await runQuery(db()
    .from('availability_blocks')
    .insert({
      id: makeId('blk'),
      date,
      start_time: startTime,
      end_time: endTime,
      full_day: fullDay,
      recurrence: repeatWeekly ? 'WEEKLY' : 'NONE',
      weekday: repeatWeekly ? dateWeekday(date) : null,
      reason: req.body.reason || req.body.motivo || '',
      created_by: req.user.id,
    })
    .select()
    .single());

  res.status(201).json(mapAvailabilityBlock(row));
}));

app.put('/api/admin/availability-blocks/:id', authenticate, requireAdmin, asyncHandler(async (req, res) => {
  const patch = { updated_at: now() };
  const date = req.body.date;
  const fullDay = req.body.fullDay ?? req.body.full_day;
  const repeatWeekly = req.body.repeatWeekly ?? (req.body.recurrence === 'WEEKLY' ? true : undefined);

  if (req.body.date !== undefined) patch.date = req.body.date;
  if (req.body.startTime || req.body.start_time) patch.start_time = req.body.startTime || req.body.start_time;
  if (req.body.endTime || req.body.end_time) patch.end_time = req.body.endTime || req.body.end_time;
  if (fullDay !== undefined) {
    patch.full_day = Boolean(fullDay);
    if (patch.full_day) {
      const policy = getSchedulePolicy(await getStudio());
      patch.start_time = policy.defaultStartTime;
      patch.end_time = policy.defaultEndTime;
    }
  }
  if (repeatWeekly !== undefined) patch.recurrence = repeatWeekly ? 'WEEKLY' : 'NONE';
  if (date !== undefined || repeatWeekly !== undefined) {
    patch.weekday = (repeatWeekly === true || req.body.recurrence === 'WEEKLY') && isDate(date)
      ? dateWeekday(date)
      : null;
  }
  if (req.body.reason !== undefined || req.body.motivo !== undefined) patch.reason = req.body.reason ?? req.body.motivo;

  const row = await runQuery(db()
    .from('availability_blocks')
    .update(patch)
    .eq('id', req.params.id)
    .select()
    .maybeSingle());

  if (!row) return res.status(404).json({ message: 'Bloqueio nao encontrado' });
  return res.json(mapAvailabilityBlock(row));
}));

app.delete('/api/admin/availability-blocks/:id', authenticate, requireAdmin, asyncHandler(async (req, res) => {
  await runQuery(db().from('availability_blocks').delete().eq('id', req.params.id));
  return res.json({ success: true });
}));

app.get('/api/appointments', authenticate, asyncHandler(async (req, res) => {
  const { status, date, from, to } = req.query;

  let query = db()
    .from('appointments')
    .select('*')
    .order('date', { ascending: true })
    .order('time', { ascending: true });

  if (!isAdminRole(req.user.role)) {
    query = query.or(`user_id.eq.${req.user.id},client_phone.eq.${req.user.phone}`);
  }
  if (status) query = query.eq('status', status);
  if (date) query = query.eq('date', date);
  if (from) query = query.gte('date', from);
  if (to) query = query.lte('date', to);

  const appointments = await runQuery(query);
  const servicesById = await getServicesByIds([...new Set(appointments.map((item) => item.service_id).filter(Boolean))]);

  res.json(appointments.map((appointment) => mapAppointment(appointment, servicesById.get(appointment.service_id))));
}));

app.post('/api/appointments', authenticate, asyncHandler(async (req, res) => {
  const serviceId = req.body.serviceId || req.body.servicoId;
  const { date, time, notes } = req.body;

  if (!serviceId || !isDate(date) || !isTime(time)) {
    return res.status(400).json({ message: 'Servico, data e horario sao obrigatorios' });
  }

  const service = await findService(serviceId);
  if (!service) return res.status(404).json({ message: 'Servico nao encontrado' });

  const slots = await getSlotsForDate(date, serviceId);
  const selectedSlot = slots.find((slot) => slot.time === time);
  if (!selectedSlot || !selectedSlot.available) return res.status(409).json({ message: 'Horario indisponivel' });

  const studio = await getStudio();
  const user = req.user;
  const startTime = selectedSlot.startTime;
  const endTime = selectedSlot.endTime;

  const depositPercent = Number(studio.policy?.depositPercent || 40);
  const { data: appointment, error } = await db()
    .from('appointments')
    .insert({
      id: makeId('apt'),
      user_id: user.id,
      client_name: user.name,
      client_phone: user.phone,
      service_id: service.id,
      service_name: service.name,
      date,
      time,
      start_time: startTime,
      end_time: endTime,
      status: 'PENDING',
      notes: notes || '',
      total_cents: service.price_cents,
      deposit_cents: Math.round(service.price_cents * (depositPercent / 100)),
    })
    .select()
    .single();

  if (error?.code === '23505') return res.status(409).json({ message: 'Horario indisponivel' });
  if (error) throw error;

  return res.status(201).json(mapAppointment(appointment, service));
}));

app.patch('/api/appointments/:id/cancel', authenticate, asyncHandler(async (req, res) => {
  const appointment = await findAppointmentById(req.params.id);
  if (!appointment) return res.status(404).json({ message: 'Agendamento nao encontrado' });
  if (!canManageAppointment(req.user, appointment)) return res.status(403).json({ message: 'Voce nao pode alterar este agendamento' });
  if (!editableAppointmentStatuses.includes(appointment.status)) {
    return res.status(409).json({ message: 'Este agendamento nao pode mais ser cancelado' });
  }

  const row = await runQuery(db()
    .from('appointments')
    .update({ status: 'CANCELLED', updated_at: now() })
    .eq('id', appointment.id)
    .select()
    .single());

  return res.json(mapAppointment(row));
}));

app.patch('/api/appointments/:id/reschedule', authenticate, asyncHandler(async (req, res) => {
  const appointment = await findAppointmentById(req.params.id);
  if (!appointment) return res.status(404).json({ message: 'Agendamento nao encontrado' });
  if (!canManageAppointment(req.user, appointment)) return res.status(403).json({ message: 'Voce nao pode alterar este agendamento' });
  if (!editableAppointmentStatuses.includes(appointment.status)) {
    return res.status(409).json({ message: 'Este agendamento nao pode mais ser remarcado' });
  }

  const serviceId = req.body.serviceId || req.body.servicoId || appointment.service_id;
  const { date, time } = req.body;

  if (!serviceId || !isDate(date) || !isTime(time)) {
    return res.status(400).json({ message: 'Servico, data e horario sao obrigatorios' });
  }

  const service = await findService(serviceId);
  if (!service) return res.status(404).json({ message: 'Servico nao encontrado' });

  const slots = await getSlotsForDate(date, serviceId, { ignoreAppointmentId: appointment.id });
  const selectedSlot = slots.find((slot) => slot.time === time);
  if (!selectedSlot || !selectedSlot.available) return res.status(409).json({ message: 'Horario indisponivel' });

  const studio = await getStudio();
  const depositPercent = Number(studio.policy?.depositPercent || 40);
  const row = await runQuery(db()
    .from('appointments')
    .update({
      service_id: service.id,
      service_name: service.name,
      date,
      time,
      start_time: selectedSlot.startTime,
      end_time: selectedSlot.endTime,
      total_cents: service.price_cents,
      deposit_cents: Math.round(service.price_cents * (depositPercent / 100)),
      updated_at: now(),
    })
    .eq('id', appointment.id)
    .select()
    .single());

  return res.json(mapAppointment(row, service));
}));

app.patch('/api/appointments/:id', authenticate, requireAdmin, asyncHandler(async (req, res) => {
  const allowedStatuses = ['PENDING', 'CONFIRMED', 'DONE', 'CANCELLED', 'NO_SHOW'];
  const { status, notes } = req.body;

  if (status && !allowedStatuses.includes(status)) {
    return res.status(400).json({ message: 'Status invalido' });
  }

  const patch = { updated_at: now() };
  if (status) patch.status = status;
  if (notes !== undefined) patch.notes = notes;

  const row = await runQuery(db()
    .from('appointments')
    .update(patch)
    .eq('id', req.params.id)
    .select()
    .maybeSingle());

  if (!row) return res.status(404).json({ message: 'Agendamento nao encontrado' });
  return res.json(mapAppointment(row));
}));

app.get('/api/admin/appointments', authenticate, requireAdmin, asyncHandler(async (req, res) => {
  const { status, date, from, to } = req.query;

  let query = db()
    .from('appointments')
    .select('*')
    .order('date', { ascending: true })
    .order('start_time', { ascending: true });

  if (status) query = query.eq('status', status);
  if (date) query = query.eq('date', date);
  if (from) query = query.gte('date', from);
  if (to) query = query.lte('date', to);

  const appointments = await runQuery(query);
  const servicesById = await getServicesByIds([...new Set(appointments.map((item) => item.service_id).filter(Boolean))]);

  res.json(appointments.map((appointment) => mapAppointment(appointment, servicesById.get(appointment.service_id))));
}));

app.patch('/api/admin/appointments/:id', authenticate, requireAdmin, asyncHandler(async (req, res) => {
  const allowedStatuses = ['PENDING', 'CONFIRMED', 'DONE', 'CANCELLED', 'NO_SHOW'];
  const { status, notes } = req.body;

  if (status && !allowedStatuses.includes(status)) {
    return res.status(400).json({ message: 'Status invalido' });
  }

  const patch = { updated_at: now() };
  if (status) patch.status = status;
  if (notes !== undefined) patch.notes = notes;

  const row = await runQuery(db()
    .from('appointments')
    .update(patch)
    .eq('id', req.params.id)
    .select()
    .maybeSingle());

  if (!row) return res.status(404).json({ message: 'Agendamento nao encontrado' });
  return res.json(mapAppointment(row));
}));

app.get('/api/promotions', asyncHandler(async (_req, res) => {
  res.json(await getPromotions());
}));

app.post('/api/promotions', authenticate, requireAdmin, asyncHandler(async (req, res) => {
  if (!req.body.title || !Array.isArray(req.body.packages)) {
    return res.status(400).json({ message: 'Titulo e pacotes sao obrigatorios' });
  }

  const promotionId = makeId('promo');
  const promotion = await runQuery(db()
    .from('promotions')
    .insert({
      id: promotionId,
      title: req.body.title,
      type: req.body.type || 'custom',
      active: req.body.active !== false,
    })
    .select()
    .single());

  const packagesPayload = req.body.packages.map((item, index) => ({
    id: item.id || makeId('pkg'),
    promotion_id: promotionId,
    name: item.name || item.nome,
    price_cents: item.priceCents ?? toCents(item.price || item.preco),
    subtitle: item.subtitle || item.subtitulo || '',
    benefits: Array.isArray(item.benefits) ? item.benefits : item.beneficios || [],
    sort_order: item.sortOrder ?? index + 1,
    active: item.active !== false,
  }));

  const packages = packagesPayload.length
    ? await runQuery(db().from('promotion_packages').insert(packagesPayload).select())
    : [];

  res.status(201).json(mapPromotion(promotion, packages));
}));

app.put('/api/promotions/:id', authenticate, requireAdmin, asyncHandler(async (req, res) => {
  const patch = { updated_at: now() };
  if (req.body.title !== undefined) patch.title = req.body.title;
  if (req.body.type !== undefined) patch.type = req.body.type;
  if (req.body.active !== undefined) patch.active = Boolean(req.body.active);

  const promotion = await runQuery(db()
    .from('promotions')
    .update(patch)
    .eq('id', req.params.id)
    .select()
    .maybeSingle());

  if (!promotion) return res.status(404).json({ message: 'Promocao nao encontrada' });

  if (Array.isArray(req.body.packages)) {
    await runQuery(db().from('promotion_packages').delete().eq('promotion_id', req.params.id));
    const packagesPayload = req.body.packages.map((item, index) => ({
      id: item.id || makeId('pkg'),
      promotion_id: req.params.id,
      name: item.name || item.nome,
      price_cents: item.priceCents ?? toCents(item.price || item.preco),
      subtitle: item.subtitle || item.subtitulo || '',
      benefits: Array.isArray(item.benefits) ? item.benefits : item.beneficios || [],
      sort_order: item.sortOrder ?? index + 1,
      active: item.active !== false,
    }));

    if (packagesPayload.length) await runQuery(db().from('promotion_packages').insert(packagesPayload));
  }

  res.json((await getPromotions({ includeInactive: true })).find((item) => item.id === req.params.id));
}));

app.delete('/api/promotions/:id', authenticate, requireAdmin, asyncHandler(async (req, res) => {
  const row = await runQuery(db()
    .from('promotions')
    .update({ active: false, updated_at: now() })
    .eq('id', req.params.id)
    .select()
    .maybeSingle());

  if (!row) return res.status(404).json({ message: 'Promocao nao encontrada' });
  return res.json({ success: true, promotion: mapPromotion(row, []) });
}));

app.post('/api/promotion-leads', asyncHandler(async (req, res) => {
  const clientName = req.body.clientName || req.body.name || req.body.nome;
  const clientPhone = onlyDigits(req.body.clientPhone || req.body.phone || req.body.whatsapp);

  if (!clientName || clientPhone.length < 10) {
    return res.status(400).json({ message: 'Nome e WhatsApp sao obrigatorios' });
  }

  const packageInfo = req.body.packageId ? await findPromotionPackage(req.body.packageId) : null;
  const user = await upsertUser({ phone: clientPhone, name: clientName, role: 'CLIENT' });
  const row = await runQuery(db()
    .from('promotion_leads')
    .insert({
      id: makeId('lead'),
      user_id: user.id,
      client_name: user.name,
      client_phone: user.phone,
      promotion_id: packageInfo?.promotion?.id || req.body.promotionId || null,
      package_id: packageInfo?.package?.id || req.body.packageId || null,
      package_name: packageInfo?.package?.name || req.body.packageName || null,
      message: req.body.message || '',
      status: 'NEW',
    })
    .select()
    .single());

  res.status(201).json({
    id: row.id,
    userId: row.user_id,
    clientName: row.client_name,
    clientPhone: row.client_phone,
    promotionId: row.promotion_id,
    packageId: row.package_id,
    packageName: row.package_name,
    message: row.message,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}));

app.get('/api/feed/posts', asyncHandler(async (_req, res) => {
  let query = db()
    .from('feed_posts')
    .select('*')
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true });

  query = query.neq('active', false);

  const rows = await runQuery(query);
  res.json(rows.map(mapFeedPost));
}));

app.post('/api/feed/posts', authenticate, requireAdmin, asyncHandler(async (req, res) => {
  if (!req.body.title || !Array.isArray(req.body.content)) {
    return res.status(400).json({ message: 'Titulo e conteudo sao obrigatorios' });
  }

  const posts = await runQuery(db().from('feed_posts').select('id'));
  const row = await runQuery(db()
    .from('feed_posts')
    .insert({
      id: makeId('post'),
      title: req.body.title,
      subtitle: req.body.subtitle || '',
      content: req.body.content,
      footer: req.body.footer || '',
      sort_order: req.body.sortOrder ?? posts.length + 1,
      active: req.body.active !== false,
    })
    .select()
    .single());

  res.status(201).json(mapFeedPost(row));
}));

app.put('/api/feed/posts/:id', authenticate, requireAdmin, asyncHandler(async (req, res) => {
  const patch = { updated_at: now() };
  if (req.body.title !== undefined) patch.title = req.body.title;
  if (req.body.subtitle !== undefined) patch.subtitle = req.body.subtitle;
  if (req.body.content !== undefined) patch.content = req.body.content;
  if (req.body.footer !== undefined) patch.footer = req.body.footer;
  if (req.body.sortOrder !== undefined) patch.sort_order = Number(req.body.sortOrder);
  if (req.body.active !== undefined) patch.active = Boolean(req.body.active);

  const row = await runQuery(db()
    .from('feed_posts')
    .update(patch)
    .eq('id', req.params.id)
    .select()
    .maybeSingle());

  if (!row) return res.status(404).json({ message: 'Post nao encontrado' });
  return res.json(mapFeedPost(row));
}));

app.delete('/api/feed/posts/:id', authenticate, requireAdmin, asyncHandler(async (req, res) => {
  const row = await runQuery(db()
    .from('feed_posts')
    .update({ active: false, updated_at: now() })
    .eq('id', req.params.id)
    .select()
    .maybeSingle());

  if (!row) return res.status(404).json({ message: 'Post nao encontrado' });
  return res.json({ success: true, post: mapFeedPost(row) });
}));

app.get('/api/clients', authenticate, requireAdmin, asyncHandler(async (_req, res) => {
  const [users, appointments] = await Promise.all([
    runQuery(db().from('app_users').select('*').neq('role', 'ADM')),
    runQuery(db().from('appointments').select('*')),
  ]);

  const clients = users.map((user) => {
    const clientAppointments = appointments.filter((appointment) => appointment.user_id === user.id && appointment.status !== 'CANCELLED');
    return {
      ...publicUser(user),
      visits: clientAppointments.filter((appointment) => appointment.status === 'DONE').length,
      totalSpentCents: clientAppointments
        .filter((appointment) => ['CONFIRMED', 'DONE'].includes(appointment.status))
        .reduce((total, appointment) => total + (appointment.total_cents || 0), 0),
    };
  });

  res.json(clients);
}));

app.get('/api/admin/dashboard', authenticate, requireAdmin, asyncHandler(async (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  const [appointments, leads] = await Promise.all([
    runQuery(db().from('appointments').select('*')),
    runQuery(db().from('promotion_leads').select('*')),
  ]);

  const monthAppointments = appointments.filter((appointment) => (
    appointment.date.startsWith(month)
    && ['CONFIRMED', 'DONE'].includes(appointment.status)
  ));
  const doneAppointments = appointments.filter((appointment) => appointment.status === 'DONE');
  const rankingMap = new Map();

  for (const appointment of doneAppointments) {
    const key = appointment.client_phone || appointment.user_id;
    const current = rankingMap.get(key) || {
      name: appointment.client_name,
      phone: appointment.client_phone,
      visits: 0,
      totalCents: 0,
    };

    current.visits += 1;
    current.totalCents += appointment.total_cents || 0;
    rankingMap.set(key, current);
  }

  res.json({
    month,
    totalMonthCents: monthAppointments.reduce((total, appointment) => total + (appointment.total_cents || 0), 0),
    appointmentsMonth: monthAppointments.length,
    servicesDone: doneAppointments.length,
    pendingAppointments: appointments.filter((appointment) => appointment.status === 'PENDING').length,
    newPromotionLeads: leads.filter((lead) => lead.status === 'NEW').length,
    ranking: Array.from(rankingMap.values())
      .sort((a, b) => b.totalCents - a.totalCents)
      .slice(0, 10),
  });
}));

app.use((req, res) => {
  res.status(404).json({ message: 'Rota nao encontrada' });
});

app.use((error, _req, res, _next) => {
  console.error(error);

  if (error.message === tableMissingMessage || error.message === schemaMissingMessage) {
    return res.status(500).json({ message: error.message });
  }

  if (error.statusCode) {
    return res.status(error.statusCode).json({ message: error.message || 'Erro no servidor' });
  }

  return res.status(500).json({ message: 'Erro interno no servidor' });
});

const start = async () => {
  await ensureSeedData();

  app.listen(PORT, () => {
    console.log(`Backend rodando na porta ${PORT}`);
    console.log('Dados salvos no Supabase');
  });
};

start().catch((error) => {
  console.error('Nao foi possivel iniciar o backend:', error.message);
  if (error.cause) console.error(error.cause);
  process.exit(1);
});
