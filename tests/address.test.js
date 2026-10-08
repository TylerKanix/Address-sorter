'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../assets/js/address.js');

test('parses CSV with quotes, commas and blank lines', () => {
  const rows = A.parseDelimited('﻿Name,Address\r\n"Smith, J","123 Main St, Apt 4"\r\n\r\nLee,"45 ""B"" Ave"\n');
  assert.deepEqual(rows, [
    ['Name', 'Address'],
    ['Smith, J', '123 Main St, Apt 4'],
    ['Lee', '45 "B" Ave'],
  ]);
});

test('parses tab-separated text pasted from a spreadsheet', () => {
  const rows = A.parseDelimited('Address\tCity\n12 Oak St\tSpringfield\n14 Oak St\tSpringfield');
  assert.deepEqual(rows[1], ['12 Oak St', 'Springfield']);
});

test('treats one address per line as a single column', () => {
  const rows = A.parseDelimited('12 Oak St\n14 Oak St\n');
  assert.deepEqual(rows, [['12 Oak St'], ['14 Oak St']]);
});

test('detects header rows', () => {
  assert.equal(A.detectHeaderRow([['Address', 'City'], ['1 Main St', 'X']]), true);
  assert.equal(A.detectHeaderRow([['1 Main St', 'X'], ['2 Main St', 'X']]), false);
  assert.equal(A.detectHeaderRow([['Customer', 'Where'], ['Bob', '2 Main St']]), true);
  assert.equal(A.detectHeaderRow([['12 Oak St'], ['14 Oak St']]), false);
});

test('maps typical column names', () => {
  const headers = ['Name', 'Street Address', 'Apt', 'City', 'State', 'Zip Code', 'Email Address', 'Phone'];
  const rows = [['Ann', '1 Main St', '', 'Springfield', 'IL', '62701', 'a@x.com', '555']];
  const m = A.detectColumns(headers, rows);
  assert.equal(m.address, 1);
  assert.equal(m.unit, 2);
  assert.equal(m.city, 3);
  assert.equal(m.state, 4);
  assert.equal(m.zip, 5);
  assert.equal(m.lat, null);
});

test('maps separate house number and street name columns', () => {
  const m = A.detectColumns(['House Number', 'Street Name', 'Town'], [['12', 'Oak St', 'Leeds']]);
  assert.equal(m.number, 0);
  assert.equal(m.address, 1);
  assert.equal(m.city, 2);
});

test('only accepts latitude/longitude columns that hold coordinates', () => {
  const ok = A.detectColumns(['Address', 'Lat', 'Lng'], [['1 Main St', '38.9', '-77.03']]);
  assert.equal(ok.lat, 1);
  assert.equal(ok.lon, 2);
  const bad = A.detectColumns(['Address', 'Lat', 'Long'], [['1 Main St', 'n/a', 'n/a']]);
  assert.equal(bad.lat, null);
  assert.equal(bad.lon, null);
});

test('finds the address column by its contents when the header is unhelpful', () => {
  const m = A.detectColumns(['Customer', 'Where'], [['Bob', '2 Main St'], ['Sue', '4 Main St']]);
  assert.equal(m.address, 1);
  const single = A.detectColumns(['Column A'], [['Buckingham Palace, London']]);
  assert.equal(single.address, 0);
});

test('normalizes street names', () => {
  assert.equal(A.normalizeStreet('North Main Street'), 'N MAIN ST');
  assert.equal(A.normalizeStreet('N. Main St.'), 'N MAIN ST');
  assert.equal(A.normalizeStreet('First Avenue'), '1ST AVE');
});

test('parses house numbers, suffixes and units', () => {
  assert.deepEqual(A.parseStreetLine('123B N Main Street Apt 4'), { number: 123, numberSuffix: 'B', street: 'N MAIN ST', unit: 'Apt 4' });
  assert.equal(A.parseStreetLine('123 B St').street, 'B ST');
  assert.equal(A.parseStreetLine('12-14 Oak Rd').number, 12);
  assert.equal(A.parseStreetLine('Main St').number, null);
  assert.equal(A.parseStreetLine('55 Elm St #2B').unit, '#2B');
});

test('builds a lookup query from separate columns', () => {
  const mapping = Object.assign(A.emptyMapping(), { address: 0, unit: 1, city: 2, state: 3, zip: 4 });
  const a = A.buildAddress(['12 Oak St', 'Apt 3', 'Springfield', 'IL', '62701'], mapping);
  assert.equal(a.query, '12 Oak St, Springfield, IL 62701');
  assert.equal(a.display, '12 Oak St Apt 3, Springfield, IL 62701');
  assert.equal(a.number, 12);
  assert.equal(a.street, 'OAK ST');
  assert.equal(a.isUS, true);
  assert.equal(a.streetKey, 'OAK ST|SPRINGFIELD IL 62701');
});

test('restores the leading zero Excel drops from US ZIP codes', () => {
  const mapping = Object.assign(A.emptyMapping(), { address: 0, city: 1, state: 2, zip: 3 });
  assert.equal(A.buildAddress(['5 Elm St', 'Boston', 'MA', '2134'], mapping).query, '5 Elm St, Boston, MA 02134');
  const mappingNoState = Object.assign(A.emptyMapping(), { address: 0, zip: 1 });
  assert.equal(A.buildAddress(['5 Elm St', '2134'], mappingNoState).query, '5 Elm St, 2134'); // not clearly US
});

test('does not repeat town or ZIP already in the address text', () => {
  const mapping = Object.assign(A.emptyMapping(), { address: 0, city: 1, zip: 2 });
  const a = A.buildAddress(['12 Oak St, Springfield, IL 62701', 'Springfield', '62701'], mapping);
  assert.equal(a.query, '12 Oak St, Springfield, IL 62701');
});

test('adds the area hint only to addresses without a town', () => {
  const mapping = Object.assign(A.emptyMapping(), { address: 0 });
  assert.equal(A.buildAddress(['12 Oak St'], mapping, { areaHint: 'Springfield, IL' }).query, '12 Oak St, Springfield, IL');
  assert.equal(A.buildAddress(['12 Oak St, Dover, DE'], mapping, { areaHint: 'Springfield, IL' }).query, '12 Oak St, Dover, DE');
  assert.equal(A.buildAddress(['12 Oak St Apt 4'], mapping, { areaHint: 'Leeds' }).query, '12 Oak St, Leeds');
});

test('infers the most common town for rows that lack one', () => {
  const mapping = Object.assign(A.emptyMapping(), { address: 0 });
  const built = ['1 A St, Dover, DE', '2 A St, Dover, DE', '3 A St'].map((t) => A.buildAddress([t], mapping));
  assert.equal(A.inferDefaultLocality(built), 'Dover, DE');
  const again = A.buildAddress(['3 A St'], mapping, { defaultLocality: 'Dover, DE' });
  assert.equal(again.query, '3 A St, Dover, DE');
});

test('marks empty rows', () => {
  const mapping = Object.assign(A.emptyMapping(), { address: 0 });
  assert.equal(A.buildAddress(['', 'x'], mapping).empty, true);
});

test('recognises US addresses', () => {
  assert.equal(A.looksUS('1600 Pennsylvania Ave NW, Washington, DC 20500'), true);
  assert.equal(A.looksUS('12 Oak St, Springfield, Illinois'), true);
  assert.equal(A.looksUS('10 Downing St, London SW1A 2AA, UK'), false);
  assert.equal(A.looksUS('Unter den Linden 77, 10117 Berlin'), false);
  const mapping = Object.assign(A.emptyMapping(), { address: 0, zip: 1, country: 2 });
  assert.equal(A.buildAddress(['Hauptstr. 5', '10117', 'Germany'], mapping).isUS, false);
});

test('parses coordinates', () => {
  assert.equal(A.parseCoordinate('38.5', 'lat'), 38.5);
  assert.equal(A.parseCoordinate(-77.1, 'lon'), -77.1);
  assert.equal(A.parseCoordinate('95', 'lat'), null);
  assert.equal(A.parseCoordinate('', 'lat'), null);
});
