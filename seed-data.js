// Seed script for Real Estate CRM (Postgres)
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');

function loadLocalEnv() {
  const envFiles = ['.env.local', '.env'];
  for (const file of envFiles) {
    const fullPath = path.join(process.cwd(), file);
    if (!fs.existsSync(fullPath)) continue;
    const lines = fs.readFileSync(fullPath, 'utf8').split(/\r?\n/);
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eqIndex = line.indexOf('=');
      if (eqIndex <= 0) continue;
      const key = line.slice(0, eqIndex).trim();
      let value = line.slice(eqIndex + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = value;
    }
  }
}

loadLocalEnv();

const POSTGRES_URL = process.env.POSTGRES_URL || process.env.DATABASE_URL;
const DOC_TABLE = 'crm_documents';

const sampleLeads = [
  {
    id: uuidv4(),
    name: 'Sarah Johnson',
    email: 'sarah.johnson@email.com',
    phone: '(555) 123-4567',
    lead_type: 'buyer',
    preferences: {
      zipcode: '90210',
      min_price: '400000',
      max_price: '600000',
      bedrooms: '3',
      bathrooms: '2'
    },
    assigned_agent: 'Mike Rodriguez',
    tags: ['first-time-buyer', 'qualified'],
    status: 'active',
    ai_insights: 'High-potential buyer with clear preferences for Beverly Hills area. Budget range indicates strong purchasing power.',
    created_at: new Date(),
    updated_at: new Date()
  },
  {
    id: uuidv4(),
    name: 'Robert Chen',
    email: 'robert.chen@email.com',
    phone: '(555) 987-6543',
    lead_type: 'seller',
    preferences: {
      zipcode: '10001',
      min_price: '800000',
      max_price: '1200000',
      bedrooms: '2',
      bathrooms: '2'
    },
    assigned_agent: 'Lisa Park',
    tags: ['luxury', 'urgent'],
    status: 'active',
    ai_insights: 'Luxury market seller with Manhattan property. High-value transaction potential.',
    created_at: new Date(Date.now() - 86400000), // 1 day ago
    updated_at: new Date()
  },
  {
    id: uuidv4(),
    name: 'Emily Davis',
    email: 'emily.davis@email.com',
    phone: '(555) 456-7890',
    lead_type: 'buyer',
    preferences: {
      zipcode: '33101',
      min_price: '300000',
      max_price: '450000',
      bedrooms: '2',
      bathrooms: '1.5'
    },
    assigned_agent: 'Carlos Martinez',
    tags: ['investor', 'cash-buyer'],
    status: 'active',
    ai_insights: 'Investment-focused buyer in Miami market. Cash position makes them highly competitive.',
    created_at: new Date(Date.now() - 172800000), // 2 days ago
    updated_at: new Date()
  },
  {
    id: uuidv4(),
    name: 'Michael Thompson',
    email: 'michael.thompson@email.com',
    phone: '(555) 789-0123',
    lead_type: 'buyer',
    preferences: {
      zipcode: '78701',
      min_price: '250000',
      max_price: '400000',
      bedrooms: '3',
      bathrooms: '2'
    },
    assigned_agent: 'Jennifer White',
    tags: ['relocating', 'family'],
    status: 'new',
    ai_insights: 'Family relocating to Austin. Looking for move-in ready properties with good schools.',
    created_at: new Date(Date.now() - 259200000), // 3 days ago
    updated_at: new Date()
  },
  {
    id: uuidv4(),
    name: 'Amanda Garcia',
    email: 'amanda.garcia@email.com',
    phone: '(555) 321-6547',
    lead_type: 'seller',
    preferences: {
      zipcode: '94102',
      min_price: '900000',
      max_price: '1300000',
      bedrooms: '3',
      bathrooms: '2.5'
    },
    assigned_agent: 'David Kim',
    tags: ['downsizing', 'senior'],
    status: 'active',
    ai_insights: 'Downsizing homeowner in San Francisco. Likely to move quickly once right property is found.',
    created_at: new Date(Date.now() - 345600000), // 4 days ago
    updated_at: new Date()
  }
];

async function seedDatabase() {
  if (!POSTGRES_URL) {
    throw new Error('POSTGRES_URL or DATABASE_URL must be set before running seed-data.js');
  }

  const pool = new Pool({
    connectionString: POSTGRES_URL,
    ssl: /sslmode=require|ssl=true/i.test(POSTGRES_URL) ? { rejectUnauthorized: false } : undefined
  });

  try {
    console.log('Connecting to Postgres...');
    await pool.query('SELECT 1');
    console.log('Connected successfully to Postgres');

    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${DOC_TABLE} (
        collection_name TEXT NOT NULL,
        doc_id TEXT NOT NULL,
        doc JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (collection_name, doc_id)
      )
    `);

    // Clear existing data
    console.log('Clearing existing leads...');
    await pool.query(`DELETE FROM ${DOC_TABLE} WHERE collection_name = $1`, ['leads']);

    // Insert sample leads
    console.log('Inserting sample leads...');
    for (const lead of sampleLeads) {
      await pool.query(
        `
          INSERT INTO ${DOC_TABLE} (collection_name, doc_id, doc, updated_at)
          VALUES ($1, $2, $3::jsonb, NOW())
          ON CONFLICT (collection_name, doc_id)
          DO UPDATE SET doc = EXCLUDED.doc, updated_at = NOW()
        `,
        ['leads', lead.id, JSON.stringify(lead)]
      );
    }
    console.log(`Inserted ${sampleLeads.length} sample leads`);

    console.log('Database seeded successfully!');

    // Display summary
    const [leadCountRow, buyerCountRow, sellerCountRow] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS c FROM ${DOC_TABLE} WHERE collection_name = $1`, ['leads']),
      pool.query(`SELECT COUNT(*)::int AS c FROM ${DOC_TABLE} WHERE collection_name = $1 AND doc->>'lead_type' = 'buyer'`, ['leads']),
      pool.query(`SELECT COUNT(*)::int AS c FROM ${DOC_TABLE} WHERE collection_name = $1 AND doc->>'lead_type' = 'seller'`, ['leads'])
    ]);

    const leadCount = leadCountRow.rows?.[0]?.c || 0;
    const buyerCount = buyerCountRow.rows?.[0]?.c || 0;
    const sellerCount = sellerCountRow.rows?.[0]?.c || 0;

    console.log('\n=== SEED SUMMARY ===');
    console.log(`Total Leads: ${leadCount}`);
    console.log(`Buyers: ${buyerCount}`);
    console.log(`Sellers: ${sellerCount}`);
    console.log('===================\n');

  } catch (error) {
    console.error('Error seeding database:', error);
  } finally {
    await pool.end();
    console.log('Postgres connection closed');
  }
}

// Run the seed script
seedDatabase();
