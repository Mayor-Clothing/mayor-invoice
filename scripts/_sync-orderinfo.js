const { google } = require('googleapis');
const CREDS = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT || '{}');
const SHEET_ID = process.env.MO_SHEET_ID;
const norm = (s)=>String(s||'').trim().toLowerCase().replace(/^po\s*#?\s*/,'').replace(/[^a-z0-9]/g,'');
const sheetSafe=(v)=>{const s=v==null?'':String(v);if(/^[=@+]/.test(s))return "'"+s;if(s[0]==='-'&&isNaN(Number(s)))return "'"+s;return s;};
const DRY = process.argv.includes('--dry');
(async()=>{
  const auth=new google.auth.GoogleAuth({credentials:CREDS,scopes:['https://www.googleapis.com/auth/spreadsheets']});
  const sheets=google.sheets({version:'v4',auth});
  const oi=(await sheets.spreadsheets.values.get({spreadsheetId:SHEET_ID,range:'Order Info!A:H'})).data.values||[];
  const oc=(await sheets.spreadsheets.values.get({spreadsheetId:SHEET_ID,range:'Order Confirmations!A:BF'})).data.values||[];
  const inv=(await sheets.spreadsheets.values.get({spreadsheetId:SHEET_ID,range:'Invoices!A:F'})).data.values||[];

  // Order Info indexes
  const oiByDeal={}, oiByOrder={};
  oi.slice(1).forEach((r,i)=>{ const rowNum=i+2; const d=String(r[7]||'').trim(); const o=norm(r[0]);
    if(d) oiByDeal[d]=oiByDeal[d]||rowNum; if(o&&!(o in oiByOrder)) oiByOrder[o]=rowNum; });
  // rowNum -> current deal_id (H) for backfill decisions
  const oiDealAt = {}; oi.slice(1).forEach((r,i)=>{ oiDealAt[i+2]=String(r[7]||'').trim(); });

  // Invoice presence
  const invDeals=new Set(inv.slice(1).map(r=>String(r[0]||'').trim()).filter(Boolean));
  const invOrders=new Set(inv.slice(1).map(r=>norm(r[5])).filter(Boolean));

  // OC orders: dealId, order#, club(8), ship(11), email(4)
  const ocOrders = oc.slice(1).filter(r=>r[0]||r[5]).map(r=>({dealId:String(r[0]||'').trim(), order:r[5]||'', club:r[8]||'', ship:r[11]||'', email:r[4]||''}));
  // how many OC deals per normalized order# (for safe backfill)
  const dealsPerOrder={}; ocOrders.forEach(o=>{ const k=norm(o.order); if(o.dealId){(dealsPerOrder[k]=dealsPerOrder[k]||new Set()).add(o.dealId);} });

  const toAppend=[], toBackfill=[], skipped=[];
  ocOrders.forEach(o=>{
    const match = (o.dealId && oiByDeal[o.dealId]) || oiByOrder[norm(o.order)];
    if(match){
      // Backfill deal_id if the matched OI row has none and this order maps to exactly one deal
      if(!oiDealAt[match] && o.dealId && dealsPerOrder[norm(o.order)] && dealsPerOrder[norm(o.order)].size===1){
        toBackfill.push({rowNum:match, dealId:o.dealId, order:o.order}); oiDealAt[match]=o.dealId;
      } else skipped.push(`${o.order} (row ${match})`);
      return;
    }
    const hasInv = (o.dealId&&invDeals.has(o.dealId)) || invOrders.has(norm(o.order));
    const status = hasInv ? 'Awaiting Payment' : 'Awaiting Customer Approval';
    toAppend.push([o.order,o.club,o.ship,o.email,status,'','',o.dealId]);
  });

  console.log(`Plan: append ${toAppend.length} new Order Info rows, backfill ${toBackfill.length} deal_ids, ${skipped.length} already present.`);
  toAppend.forEach(r=>console.log(`  + ${r[0]}  [${r[4]}]  deal ${r[7]||'(none)'}`));
  toBackfill.forEach(b=>console.log(`  ~ backfill deal_id ${b.dealId} into row ${b.rowNum} (${b.order})`));
  if(DRY){console.log('\n[dry run — nothing written]');return;}

  if(toBackfill.length){
    await sheets.spreadsheets.values.batchUpdate({spreadsheetId:SHEET_ID,requestBody:{valueInputOption:'USER_ENTERED',
      data:toBackfill.map(b=>({range:`Order Info!H${b.rowNum}`,values:[[sheetSafe(b.dealId)]]}))}});
  }
  if(toAppend.length){
    await sheets.spreadsheets.values.append({spreadsheetId:SHEET_ID,range:'Order Info!A1',valueInputOption:'USER_ENTERED',insertDataOption:'INSERT_ROWS',
      requestBody:{values:toAppend.map(r=>r.map(sheetSafe))}});
  }
  console.log('\nDONE.');
})().catch(e=>{console.error('FATAL',e.stack||e.message);process.exit(1);});
