// Ported from v1 `_shared/owner-patterns.ts`: metro and state -> city lists.
// The async AI-expanding variant is dropped. A location we cannot expand
// statically becomes a single-city query rather than a network call inside a
// helper, and Long Island / metro phrasings are already in the tables.

// Metro-area → surrounding cities (for major metro inputs)
export const LOCATION_MAP: Record<string, string[]> = {
  // Sub-state regions. geo.ts already resolves these for scoping; without a
  // matching expansion entry they collapse to a single query and starve the
  // scrape. Long Island = Nassau + Suffolk, largest towns first.
  'long island':   ['Garden City NY', 'Hicksville NY', 'Huntington NY', 'Massapequa NY', 'Great Neck NY', 'Manhasset NY', 'Syosset NY', 'Plainview NY', 'Levittown NY', 'Mineola NY', 'Rockville Centre NY', 'Freeport NY', 'Long Beach NY', 'Valley Stream NY', 'Hempstead NY', 'Westbury NY', 'Farmingdale NY', 'Melville NY', 'Commack NY', 'Smithtown NY', 'Babylon NY', 'Islip NY', 'Bay Shore NY', 'Patchogue NY', 'Riverhead NY', 'Southampton NY', 'Port Jefferson NY', 'Stony Brook NY', 'Ronkonkoma NY', 'Deer Park NY'],
  'nassau county': ['Garden City NY', 'Hicksville NY', 'Massapequa NY', 'Great Neck NY', 'Manhasset NY', 'Syosset NY', 'Levittown NY', 'Mineola NY', 'Rockville Centre NY', 'Freeport NY', 'Long Beach NY', 'Valley Stream NY', 'Hempstead NY', 'Westbury NY'],
  'suffolk county': ['Huntington NY', 'Melville NY', 'Commack NY', 'Smithtown NY', 'Babylon NY', 'Islip NY', 'Bay Shore NY', 'Patchogue NY', 'Riverhead NY', 'Southampton NY', 'Port Jefferson NY', 'Stony Brook NY', 'Ronkonkoma NY', 'Deer Park NY', 'Farmingdale NY'],
  'westchester':   ['White Plains NY', 'Yonkers NY', 'New Rochelle NY', 'Mount Vernon NY', 'Scarsdale NY', 'Rye NY', 'Harrison NY', 'Mamaroneck NY', 'Port Chester NY', 'Tarrytown NY'],
  'hudson valley': ['Poughkeepsie NY', 'Newburgh NY', 'Kingston NY', 'Middletown NY', 'Nyack NY', 'Beacon NY', 'New Paltz NY', 'Fishkill NY'],
  'san francisco': ['San Francisco', 'Oakland', 'Berkeley', 'San Jose', 'Fremont', 'Hayward', 'Daly City', 'Richmond', 'Concord', 'Walnut Creek'],
  'los angeles':   ['Los Angeles', 'Hollywood', 'Santa Monica', 'Long Beach', 'Burbank', 'Glendale', 'Pasadena', 'Torrance', 'Inglewood', 'Compton'],
  'new york city': ['Manhattan', 'Brooklyn', 'Queens', 'Bronx', 'Staten Island', 'Hoboken', 'Jersey City', 'Newark'],
  'nyc':           ['Manhattan', 'Brooklyn', 'Queens', 'Bronx', 'Staten Island', 'Hoboken', 'Jersey City', 'Newark'],
  'chicago':       ['Chicago', 'Evanston', 'Oak Park', 'Naperville', 'Aurora', 'Joliet', 'Schaumburg', 'Waukegan'],
  'houston':       ['Houston', 'Sugar Land', 'Pearland', 'Pasadena', 'The Woodlands', 'Katy', 'Baytown', 'Missouri City'],
  'phoenix':       ['Phoenix', 'Scottsdale', 'Tempe', 'Mesa', 'Chandler', 'Gilbert', 'Glendale', 'Peoria'],
  'dallas':        ['Dallas', 'Fort Worth', 'Plano', 'Garland', 'Irving', 'Frisco', 'McKinney', 'Arlington'],
  'denver':        ['Denver', 'Aurora', 'Lakewood', 'Arvada', 'Westminster', 'Thornton', 'Centennial', 'Boulder'],
  'seattle':       ['Seattle', 'Bellevue', 'Tacoma', 'Redmond', 'Kirkland', 'Renton', 'Everett', 'Burien'],
  'austin':        ['Austin', 'Round Rock', 'Cedar Park', 'Pflugerville', 'Georgetown', 'Kyle', 'Buda', 'Leander'],
  'miami':         ['Miami', 'Miami Beach', 'Coral Gables', 'Hialeah', 'Fort Lauderdale', 'Boca Raton', 'Hollywood', 'Deerfield Beach'],
  'atlanta':       ['Atlanta', 'Decatur', 'Sandy Springs', 'Marietta', 'Roswell', 'Alpharetta', 'Smyrna', 'Dunwoody'],
  'boston':        ['Boston', 'Cambridge', 'Somerville', 'Brookline', 'Newton', 'Quincy', 'Waltham', 'Malden'],
  'las vegas':     ['Las Vegas', 'Henderson', 'North Las Vegas', 'Summerlin', 'Enterprise', 'Spring Valley'],
  'portland':      ['Portland', 'Beaverton', 'Hillsboro', 'Lake Oswego', 'Gresham', 'Tigard', 'Tualatin'],
  'minneapolis':   ['Minneapolis', 'Saint Paul', 'Bloomington', 'Plymouth', 'Brooklyn Park', 'Maple Grove', 'Eden Prairie'],
  'san diego':     ['San Diego', 'Chula Vista', 'El Cajon', 'Escondido', 'Oceanside', 'Vista', 'Santee'],
  'nashville':     ['Nashville', 'Murfreesboro', 'Franklin', 'Hendersonville', 'Smyrna', 'Brentwood', 'Clarksville'],
  'charlotte':     ['Charlotte', 'Concord', 'Gastonia', 'Rock Hill', 'Huntersville', 'Matthews', 'Monroe'],
  'detroit':       ['Detroit', 'Warren', 'Sterling Heights', 'Ann Arbor', 'Dearborn', 'Livonia', 'Westland'],
  'philadelphia':  ['Philadelphia', 'Camden', 'Chester', 'Norristown', 'Upper Darby', 'Bensalem', 'Springfield'],
  'san antonio':   ['San Antonio', 'New Braunfels', 'Schertz', 'Converse', 'Universal City', 'Boerne', 'Seguin'],
  'baltimore':     ['Baltimore', 'Towson', 'Columbia', 'Catonsville', 'Dundalk', 'Ellicott City', 'Glen Burnie'],
  'sacramento':    ['Sacramento', 'Roseville', 'Elk Grove', 'Folsom', 'Rancho Cordova', 'Davis', 'Woodland', 'Citrus Heights'],
  'virginia':      ['Virginia Beach', 'Norfolk', 'Chesapeake', 'Richmond', 'Arlington', 'Newport News', 'Alexandria', 'Hampton', 'Roanoke', 'Suffolk', 'Portsmouth', 'Lynchburg', 'Harrisonburg', 'Charlottesville', 'Fredericksburg'],
  'northern virginia': ['Arlington', 'Alexandria', 'Fairfax', 'Reston', 'Herndon', 'Sterling', 'Ashburn', 'Leesburg', 'Manassas', 'Woodbridge'],
  'richmond':      ['Richmond', 'Henrico', 'Chesterfield', 'Midlothian', 'Mechanicsville', 'Glen Allen', 'Ashland', 'Petersburg', 'Colonial Heights', 'Hopewell'],
  'hampton roads': ['Virginia Beach', 'Norfolk', 'Chesapeake', 'Hampton', 'Newport News', 'Portsmouth', 'Suffolk', 'Poquoson', 'Williamsburg', 'York County'],
  'ontario':       ['Toronto', 'Ottawa', 'Mississauga', 'Brampton', 'Hamilton', 'London', 'Markham', 'Vaughan', 'Kitchener', 'Windsor', 'Richmond Hill', 'Burlington', 'Oakville', 'Oshawa', 'Barrie', 'Guelph', 'Sudbury', 'Kingston', 'Thunder Bay', 'Waterloo', 'St. Catharines', 'Cambridge', 'Whitby', 'Ajax', 'Pickering', 'Brantford', 'Newmarket', 'Peterborough'],
}

// US states + Canadian provinces → comprehensive city lists for state-level scraping
export const STATE_MAP: Record<string, string[]> = {
  // US States
  'alabama': ['Birmingham', 'Montgomery', 'Huntsville', 'Mobile', 'Tuscaloosa', 'Hoover', 'Dothan', 'Auburn', 'Decatur', 'Madison', 'Florence', 'Vestavia Hills', 'Prattville', 'Phenix City', 'Gadsden', 'Alabaster', 'Bessemer', 'Enterprise', 'Opelika', 'Northport', 'Homewood', 'Anniston', 'Athens', 'Daphne', 'Pelham', 'Oxford', 'Albertville', 'Trussville', 'Selma', 'Talladega', 'Troy', 'Jasper', 'Cullman', 'Muscle Shoals', 'Scottsboro', 'Fairhope', 'Ozark', 'Prichard', 'Hueytown'],
  'al': ['Birmingham', 'Montgomery', 'Huntsville', 'Mobile', 'Tuscaloosa', 'Hoover', 'Dothan', 'Auburn', 'Decatur', 'Madison', 'Florence', 'Vestavia Hills', 'Prattville', 'Phenix City', 'Gadsden', 'Alabaster', 'Bessemer', 'Enterprise', 'Opelika', 'Northport'],

  'alaska': ['Anchorage', 'Fairbanks', 'Juneau', 'Sitka', 'Ketchikan', 'Wasilla', 'Kenai', 'Kodiak', 'Bethel', 'Palmer', 'Homer', 'Unalaska', 'Barrow', 'Soldotna', 'Valdez', 'Nome', 'Kotzebue', 'Seward', 'Wrangell', 'Petersburg'],
  'ak': ['Anchorage', 'Fairbanks', 'Juneau', 'Sitka', 'Ketchikan', 'Wasilla', 'Kenai', 'Kodiak', 'Bethel', 'Palmer'],

  'arizona': ['Phoenix', 'Tucson', 'Mesa', 'Chandler', 'Scottsdale', 'Gilbert', 'Glendale', 'Tempe', 'Peoria', 'Surprise', 'Yuma', 'Avondale', 'Goodyear', 'Flagstaff', 'Casa Grande', 'Lake Havasu City', 'Maricopa', 'Sierra Vista', 'Oro Valley', 'Prescott', 'Buckeye', 'Fountain Hills', 'Prescott Valley', 'Apache Junction', 'El Mirage', 'Queen Creek', 'Marana', 'Florence', 'Kingman', 'Sahuarita', 'Bullhead City', 'Chino Valley', 'Douglas', 'Show Low', 'Safford', 'Coolidge', 'Globe', 'Nogales', 'Camp Verde'],
  'az': ['Phoenix', 'Tucson', 'Mesa', 'Chandler', 'Scottsdale', 'Gilbert', 'Glendale', 'Tempe', 'Peoria', 'Surprise', 'Yuma', 'Avondale', 'Goodyear', 'Flagstaff', 'Casa Grande', 'Lake Havasu City', 'Maricopa', 'Sierra Vista', 'Prescott', 'Buckeye'],

  'arkansas': ['Little Rock', 'Fort Smith', 'Fayetteville', 'Springdale', 'Jonesboro', 'North Little Rock', 'Conway', 'Rogers', 'Pine Bluff', 'Bentonville', 'Hot Springs', 'Benton', 'Texarkana', 'Sherwood', 'Jacksonville', 'Russellville', 'Bella Vista', 'West Memphis', 'Paragould', 'Cabot', 'Searcy', 'Van Buren', 'El Dorado', 'Maumelle', 'Blytheville', 'Bryant', 'Forrest City', 'Harrison', 'Mountain Home', 'Siloam Springs'],
  'ar': ['Little Rock', 'Fort Smith', 'Fayetteville', 'Springdale', 'Jonesboro', 'North Little Rock', 'Conway', 'Rogers', 'Pine Bluff', 'Bentonville'],

  'california': ['Los Angeles', 'San Diego', 'San Jose', 'San Francisco', 'Fresno', 'Sacramento', 'Long Beach', 'Oakland', 'Bakersfield', 'Anaheim', 'Santa Ana', 'Riverside', 'Stockton', 'Irvine', 'Chula Vista', 'Fremont', 'San Bernardino', 'Modesto', 'Fontana', 'Moreno Valley', 'Glendale', 'Huntington Beach', 'Santa Clarita', 'Garden Grove', 'Oceanside', 'Rancho Cucamonga', 'Ontario', 'Lancaster', 'Elk Grove', 'Palmdale', 'Salinas', 'Hayward', 'Sunnyvale', 'Pomona', 'Escondido', 'Torrance', 'Pasadena', 'Roseville', 'Fullerton', 'Visalia', 'Concord', 'Thousand Oaks', 'Simi Valley', 'Murrieta', 'Santa Rosa', 'Santa Clara', 'Berkeley', 'Clovis', 'Corona', 'Vallejo', 'Victorville', 'El Monte', 'Downey', 'Costa Mesa', 'Inglewood', 'Daly City', 'West Covina', 'Norwalk', 'Burbank'],
  'ca': ['Los Angeles', 'San Diego', 'San Jose', 'San Francisco', 'Fresno', 'Sacramento', 'Long Beach', 'Oakland', 'Bakersfield', 'Anaheim', 'Santa Ana', 'Riverside', 'Stockton', 'Irvine', 'Chula Vista', 'Fremont', 'San Bernardino', 'Modesto', 'Fontana', 'Moreno Valley'],

  'colorado': ['Denver', 'Colorado Springs', 'Aurora', 'Fort Collins', 'Lakewood', 'Thornton', 'Arvada', 'Westminster', 'Pueblo', 'Boulder', 'Centennial', 'Highlands Ranch', 'Castle Rock', 'Greeley', 'Longmont', 'Loveland', 'Broomfield', 'Parker', 'Commerce City', 'Northglenn', 'Brighton', 'Englewood', 'Wheat Ridge', 'Littleton', 'Grand Junction', 'Durango', 'Montrose', 'Steamboat Springs', 'Johnstown', 'Erie', 'Windsor', 'Frederick', 'Dacono', 'Pueblo West', 'Clifton', 'Sterling', 'Canon City'],
  'co': ['Denver', 'Colorado Springs', 'Aurora', 'Fort Collins', 'Lakewood', 'Thornton', 'Arvada', 'Westminster', 'Pueblo', 'Boulder', 'Centennial', 'Castle Rock', 'Greeley', 'Longmont', 'Loveland', 'Broomfield'],

  'connecticut': ['Bridgeport', 'New Haven', 'Stamford', 'Hartford', 'Waterbury', 'Norwalk', 'Danbury', 'New Britain', 'Greenwich', 'Meriden', 'Bristol', 'West Hartford', 'Milford', 'Stratford', 'East Hartford', 'West Haven', 'Middletown', 'Shelton', 'Torrington', 'Norwich', 'Fairfield', 'Hamden', 'Enfield', 'Southington', 'New Milford', 'Groton', 'Trumbull', 'Wallingford', 'Glastonbury', 'Cheshire', 'Naugatuck', 'Monroe', 'Newington', 'Manchester', 'Ansonia', 'Wethersfield'],
  'ct': ['Bridgeport', 'New Haven', 'Stamford', 'Hartford', 'Waterbury', 'Norwalk', 'Danbury', 'New Britain', 'Greenwich', 'Meriden', 'Bristol', 'West Hartford'],

  'delaware': ['Wilmington', 'Dover', 'Newark', 'Middletown', 'Smyrna', 'Milford', 'Seaford', 'Georgetown', 'Elsmere', 'New Castle', 'Millsboro', 'Laurel', 'Harrington', 'Camden', 'Lewes', 'Milton', 'Selbyville', 'Bridgeville', 'Townsend'],
  'de': ['Wilmington', 'Dover', 'Newark', 'Middletown', 'Smyrna', 'Milford', 'Seaford', 'Georgetown'],

  'florida': ['Jacksonville', 'Miami', 'Tampa', 'Orlando', 'St. Petersburg', 'Hialeah', 'Tallahassee', 'Fort Lauderdale', 'Port St. Lucie', 'Cape Coral', 'Pembroke Pines', 'Hollywood', 'Miramar', 'Gainesville', 'Coral Springs', 'Clearwater', 'Palm Bay', 'Pompano Beach', 'West Palm Beach', 'Lakeland', 'Davie', 'Miami Gardens', 'Sunrise', 'Plantation', 'Boca Raton', 'Deltona', 'Largo', 'Palm Coast', 'Deerfield Beach', 'Melbourne', 'Boynton Beach', 'Lauderhill', 'Kissimmee', 'Fort Myers', 'Daytona Beach', 'North Port', 'Jupiter', 'Wellington', 'Ocala', 'Pensacola', 'Sarasota', 'Bonita Springs', 'Bradenton', 'St. Cloud', 'Sanford', 'Margate', 'Coconut Creek', 'Tamarac', 'Punta Gorda', 'Delray Beach', 'Coral Springs', 'Port Orange', 'Altamonte Springs', 'Clermont'],
  'fl': ['Jacksonville', 'Miami', 'Tampa', 'Orlando', 'St. Petersburg', 'Hialeah', 'Tallahassee', 'Fort Lauderdale', 'Port St. Lucie', 'Cape Coral', 'Pembroke Pines', 'Hollywood', 'Miramar', 'Gainesville', 'Coral Springs', 'Clearwater', 'Palm Bay', 'West Palm Beach', 'Lakeland', 'Boca Raton'],

  'georgia': ['Atlanta', 'Columbus', 'Augusta', 'Macon', 'Savannah', 'Athens', 'Sandy Springs', 'Roswell', 'South Fulton', 'Johns Creek', 'Albany', 'Warner Robins', 'Alpharetta', 'Marietta', 'Smyrna', 'Valdosta', 'Brookhaven', 'Dunwoody', 'Peachtree City', 'Gainesville', 'East Point', 'Hinesville', 'Rome', 'Fayetteville', 'Kennesaw', 'Woodstock', 'Canton', 'Douglasville', 'Newnan', 'Dalton', 'Lawrenceville', 'Carrollton', 'LaGrange', 'Griffin', 'Thomasville', 'Statesboro', 'Suwanee', 'Powder Springs', 'Milton', 'Acworth', 'Sugar Hill', 'Cumming', 'Buford', 'Cartersville', 'Milledgeville', 'Dublin', 'Brunswick', 'Tifton'],
  'ga': ['Atlanta', 'Columbus', 'Augusta', 'Macon', 'Savannah', 'Athens', 'Sandy Springs', 'Roswell', 'Marietta', 'Smyrna', 'Valdosta', 'Alpharetta', 'Dunwoody', 'Gainesville', 'Kennesaw', 'Lawrenceville', 'Douglasville', 'Newnan'],

  'hawaii': ['Honolulu', 'Hilo', 'Kailua', 'Kapolei', 'Kaneohe', 'Pearl City', 'Waipahu', 'Aiea', 'Mililani', 'Kahului', 'Ewa Beach', 'Kihei', 'Makakilo', 'Wahiawa', 'Schofield Barracks', 'Nanakuli', 'Lahaina', 'Kailua-Kona', 'Wailuku', 'Kapaa'],
  'hi': ['Honolulu', 'Hilo', 'Kailua', 'Kapolei', 'Kaneohe', 'Pearl City', 'Waipahu', 'Mililani', 'Kahului', 'Ewa Beach'],

  'idaho': ['Boise', 'Meridian', 'Nampa', 'Idaho Falls', 'Pocatello', 'Caldwell', 'Coeur d\'Alene', 'Twin Falls', 'Post Falls', 'Lewiston', 'Rexburg', 'Eagle', 'Moscow', 'Ammon', 'Chubbuck', 'Mountain Home', 'Garden City', 'Hayden', 'Blackfoot', 'Burley', 'Jerome', 'Kuna', 'Sandpoint', 'Star', 'Middleton'],
  'id': ['Boise', 'Meridian', 'Nampa', 'Idaho Falls', 'Pocatello', 'Caldwell', 'Coeur d\'Alene', 'Twin Falls', 'Post Falls', 'Lewiston'],

  'illinois': ['Chicago', 'Aurora', 'Joliet', 'Naperville', 'Rockford', 'Springfield', 'Elgin', 'Peoria', 'Champaign', 'Waukegan', 'Cicero', 'Bloomington', 'Decatur', 'Evanston', 'Des Plaines', 'Schaumburg', 'Bolingbrook', 'Palatine', 'Skokie', 'Orland Park', 'Berwyn', 'Mount Prospect', 'Oak Lawn', 'Downers Grove', 'Normal', 'Tinley Park', 'Moline', 'Wheaton', 'Elmhurst', 'Gurnee', 'Carol Stream', 'Oak Park', 'Woodridge', 'Lombard', 'Galesburg', 'Quincy', 'Calumet City', 'Hoffman Estates', 'Romeoville', 'Plainfield', 'Belleville', 'Round Lake Beach', 'Bartlett', 'Streamwood', 'Carpentersville'],
  'il': ['Chicago', 'Aurora', 'Joliet', 'Naperville', 'Rockford', 'Springfield', 'Elgin', 'Peoria', 'Champaign', 'Waukegan', 'Bloomington', 'Decatur', 'Evanston', 'Schaumburg', 'Bolingbrook'],

  'indiana': ['Indianapolis', 'Fort Wayne', 'Evansville', 'South Bend', 'Carmel', 'Fishers', 'Bloomington', 'Hammond', 'Gary', 'Lafayette', 'Muncie', 'Terre Haute', 'Kokomo', 'Anderson', 'Noblesville', 'Greenwood', 'Elkhart', 'Mishawaka', 'Lawrence', 'Jeffersonville', 'Columbus', 'Portage', 'New Albany', 'Richmond', 'Munster', 'Westfield', 'Valparaiso', 'Michigan City', 'Merrillville', 'Avon', 'Plainfield', 'Schererville', 'Zionsville', 'Goshen', 'Logansport', 'Marion', 'Bedford', 'Vincennes'],
  'in': ['Indianapolis', 'Fort Wayne', 'Evansville', 'South Bend', 'Carmel', 'Fishers', 'Bloomington', 'Hammond', 'Gary', 'Lafayette', 'Muncie', 'Terre Haute', 'Kokomo', 'Anderson', 'Noblesville'],

  'iowa': ['Des Moines', 'Cedar Rapids', 'Davenport', 'Sioux City', 'Iowa City', 'Ankeny', 'Waterloo', 'West Des Moines', 'Ames', 'Council Bluffs', 'Dubuque', 'Urbandale', 'Johnston', 'Waukee', 'Marion', 'Cedar Falls', 'Bettendorf', 'Mason City', 'Marshalltown', 'Ottumwa', 'Clinton', 'Fort Dodge', 'Burlington', 'Coralville', 'North Liberty', 'Altoona', 'Clive', 'Muscatine', 'Grinnell', 'Spencer'],
  'ia': ['Des Moines', 'Cedar Rapids', 'Davenport', 'Sioux City', 'Iowa City', 'Ankeny', 'Waterloo', 'West Des Moines', 'Ames', 'Council Bluffs'],

  'kansas': ['Wichita', 'Overland Park', 'Kansas City', 'Topeka', 'Olathe', 'Lawrence', 'Shawnee', 'Manhattan', 'Lenexa', 'Salina', 'Hutchinson', 'Leavenworth', 'Leawood', 'Dodge City', 'Garden City', 'Emporia', 'Derby', 'Liberal', 'Gardner', 'Great Bend', 'Hays', 'Prairie Village', 'Junction City', 'Newton', 'Pittsburg', 'Parsons', 'Coffeyville', 'Atchison', 'Ottawa', 'Winfield'],
  'ks': ['Wichita', 'Overland Park', 'Kansas City', 'Topeka', 'Olathe', 'Lawrence', 'Shawnee', 'Manhattan', 'Lenexa', 'Salina'],

  'kentucky': ['Louisville', 'Lexington', 'Bowling Green', 'Owensboro', 'Covington', 'Hopkinsville', 'Frankfort', 'Nicholasville', 'Florence', 'Georgetown', 'Henderson', 'Richmond', 'Elizabethtown', 'Jeffersontown', 'Madisonville', 'Paducah', 'Radcliff', 'Ashland', 'Winchester', 'Shelbyville', 'Burlington', 'Danville', 'Erlanger', 'Campbellsville', 'Berea', 'Murray', 'Somerset', 'Glasgow', 'London', 'Corbin', 'Lawrenceburg'],
  'ky': ['Louisville', 'Lexington', 'Bowling Green', 'Owensboro', 'Covington', 'Hopkinsville', 'Frankfort', 'Nicholasville', 'Florence', 'Georgetown'],

  'louisiana': ['New Orleans', 'Baton Rouge', 'Shreveport', 'Metairie', 'Lafayette', 'Lake Charles', 'Kenner', 'Bossier City', 'Monroe', 'Alexandria', 'Prairieville', 'Marrero', 'Hammond', 'New Iberia', 'Central', 'Laplace', 'Mandeville', 'Ruston', 'Natchitoches', 'Slidell', 'Sulphur', 'Houma', 'Zachary', 'Thibodaux', 'Morgan City', 'Covington', 'Bastrop', 'Opelousas', 'Crowley', 'Gretna'],
  'la': ['New Orleans', 'Baton Rouge', 'Shreveport', 'Metairie', 'Lafayette', 'Lake Charles', 'Kenner', 'Bossier City', 'Monroe', 'Alexandria'],

  'maine': ['Portland', 'Lewiston', 'Bangor', 'South Portland', 'Auburn', 'Biddeford', 'Sanford', 'Brunswick', 'Augusta', 'Saco', 'Westbrook', 'Waterville', 'Presque Isle', 'Brewer', 'Bath', 'Caribou', 'Ellsworth', 'Old Town', 'Rockland', 'Belfast'],
  'me': ['Portland', 'Lewiston', 'Bangor', 'South Portland', 'Auburn', 'Biddeford', 'Sanford', 'Brunswick', 'Augusta', 'Saco'],

  'maryland': ['Baltimore', 'Columbia', 'Germantown', 'Silver Spring', 'Waldorf', 'Glen Burnie', 'Ellicott City', 'Dundalk', 'Rockville', 'Bethesda', 'Gaithersburg', 'Frederick', 'Towson', 'Bowie', 'Annapolis', 'College Park', 'Laurel', 'Greenbelt', 'Hagerstown', 'Catonsville', 'Hyattsville', 'Westminster', 'Salisbury', 'Potomac', 'Severn', 'Odenton', 'Edgewood', 'Pikesville', 'Owings Mills', 'Essex', 'Perry Hall', 'Randallstown', 'Aspen Hill', 'Crofton', 'Clinton'],
  'md': ['Baltimore', 'Columbia', 'Germantown', 'Silver Spring', 'Waldorf', 'Glen Burnie', 'Ellicott City', 'Rockville', 'Bethesda', 'Gaithersburg', 'Frederick', 'Towson', 'Bowie', 'Annapolis'],

  'massachusetts': ['Boston', 'Worcester', 'Springfield', 'Cambridge', 'Lowell', 'Brockton', 'New Bedford', 'Fall River', 'Lynn', 'Quincy', 'Newton', 'Somerville', 'Framingham', 'Haverhill', 'Waltham', 'Malden', 'Brookline', 'Plymouth', 'Medford', 'Taunton', 'Chicopee', 'Weymouth', 'Revere', 'Peabody', 'Methuen', 'Barnstable', 'Pittsfield', 'Attleboro', 'Fitchburg', 'Holyoke', 'Everett', 'Westfield', 'Lawrence', 'Northampton', 'Leominster', 'Billerica', 'Salem', 'Woburn', 'Chelmsford', 'Braintree'],
  'ma': ['Boston', 'Worcester', 'Springfield', 'Cambridge', 'Lowell', 'Brockton', 'New Bedford', 'Fall River', 'Lynn', 'Quincy', 'Newton', 'Somerville', 'Framingham', 'Haverhill', 'Waltham', 'Malden', 'Brookline', 'Plymouth'],

  'michigan': ['Detroit', 'Grand Rapids', 'Warren', 'Sterling Heights', 'Lansing', 'Ann Arbor', 'Flint', 'Dearborn', 'Livonia', 'Westland', 'Troy', 'Farmington Hills', 'Kalamazoo', 'Wyoming', 'Southfield', 'Rochester Hills', 'Taylor', 'Pontiac', 'St. Clair Shores', 'Royal Oak', 'Dearborn Heights', 'Novi', 'Waterford', 'Saginaw', 'Lincoln Park', 'Clinton Township', 'Canton', 'Shelby Township', 'Redford', 'Macomb', 'Muskegon', 'Jackson', 'Traverse City', 'Bay City', 'Midland', 'Battle Creek', 'Portage', 'East Lansing'],
  'mi': ['Detroit', 'Grand Rapids', 'Warren', 'Sterling Heights', 'Lansing', 'Ann Arbor', 'Flint', 'Dearborn', 'Livonia', 'Westland', 'Troy', 'Farmington Hills', 'Kalamazoo', 'Southfield'],

  'minnesota': ['Minneapolis', 'Saint Paul', 'Rochester', 'Bloomington', 'Duluth', 'Brooklyn Park', 'Plymouth', 'Maple Grove', 'Woodbury', 'St. Cloud', 'Eagan', 'Eden Prairie', 'Coon Rapids', 'Burnsville', 'Blaine', 'Lakeville', 'Minnetonka', 'Apple Valley', 'Edina', 'St. Louis Park', 'Mankato', 'Moorhead', 'Shakopee', 'Maplewood', 'Cottage Grove', 'Richfield', 'Roseville', 'Fridley', 'Brooklyn Center', 'Inver Grove Heights', 'Shoreview', 'Chaska', 'Prior Lake', 'Elk River', 'Andover', 'Champlin', 'Oakdale', 'White Bear Lake'],
  'mn': ['Minneapolis', 'Saint Paul', 'Rochester', 'Bloomington', 'Duluth', 'Brooklyn Park', 'Plymouth', 'Maple Grove', 'Woodbury', 'St. Cloud', 'Eagan', 'Eden Prairie', 'Burnsville', 'Blaine', 'Lakeville'],

  'mississippi': ['Jackson', 'Gulfport', 'Southaven', 'Hattiesburg', 'Biloxi', 'Olive Branch', 'Tupelo', 'Meridian', 'Greenville', 'Horn Lake', 'Pearl', 'Madison', 'Clinton', 'Ridgeland', 'Starkville', 'Columbus', 'Vicksburg', 'Pascagoula', 'Brandon', 'Oxford', 'Laurel', 'Natchez', 'Hernando', 'Long Beach', 'Gautier', 'Corinth', 'D\'Iberville', 'Flowood', 'Canton', 'Grenada'],
  'ms': ['Jackson', 'Gulfport', 'Southaven', 'Hattiesburg', 'Biloxi', 'Olive Branch', 'Tupelo', 'Meridian', 'Greenville', 'Horn Lake'],

  'missouri': ['Kansas City', 'St. Louis', 'Springfield', 'Columbia', 'Independence', 'Lee\'s Summit', 'O\'Fallon', 'St. Joseph', 'St. Charles', 'Blue Springs', 'Joplin', 'Chesterfield', 'Jefferson City', 'Cape Girardeau', 'Florissant', 'Wentzville', 'St. Peters', 'Ballwin', 'Kirkwood', 'Maryland Heights', 'Hazelwood', 'Raytown', 'Ferguson', 'Wildwood', 'Liberty', 'University City', 'Clayton', 'Creve Coeur', 'Bridgeton', 'Poplar Bluff', 'Sedalia', 'Rolla'],
  'mo': ['Kansas City', 'St. Louis', 'Springfield', 'Columbia', 'Independence', 'Lee\'s Summit', 'O\'Fallon', 'St. Joseph', 'St. Charles', 'Blue Springs', 'Joplin', 'Chesterfield', 'Jefferson City'],

  'montana': ['Billings', 'Missoula', 'Great Falls', 'Bozeman', 'Butte', 'Helena', 'Kalispell', 'Havre', 'Anaconda', 'Miles City', 'Belgrade', 'Livingston', 'Whitefish', 'Lewistown', 'Sidney', 'Laurel', 'Glendive', 'Cut Bank', 'Polson', 'Hamilton'],
  'mt': ['Billings', 'Missoula', 'Great Falls', 'Bozeman', 'Butte', 'Helena', 'Kalispell', 'Havre', 'Belgrade', 'Livingston'],

  'nebraska': ['Omaha', 'Lincoln', 'Bellevue', 'Grand Island', 'Kearney', 'Fremont', 'Hastings', 'Norfolk', 'Columbus', 'Papillion', 'La Vista', 'Scottsbluff', 'South Sioux City', 'North Platte', 'Beatrice', 'Lexington', 'Gering', 'Alliance', 'Ralston', 'Blair', 'York', 'Chadron', 'Seward', 'McCook'],
  'ne': ['Omaha', 'Lincoln', 'Bellevue', 'Grand Island', 'Kearney', 'Fremont', 'Hastings', 'Norfolk', 'Columbus', 'Papillion'],

  'nevada': ['Las Vegas', 'Henderson', 'Reno', 'North Las Vegas', 'Sparks', 'Carson City', 'Elko', 'Mesquite', 'Fallon', 'Fernley', 'Laughlin', 'Spring Creek', 'Boulder City', 'Winnemucca', 'Ely', 'Pahrump', 'Enterprise', 'Sunrise Manor', 'Whitney', 'Paradise'],
  'nv': ['Las Vegas', 'Henderson', 'Reno', 'North Las Vegas', 'Sparks', 'Carson City', 'Elko', 'Mesquite', 'Fallon', 'Pahrump'],

  'new hampshire': ['Manchester', 'Nashua', 'Concord', 'Dover', 'Rochester', 'Salem', 'Merrimack', 'Hudson', 'Derry', 'Londonderry', 'Exeter', 'Keene', 'Bedford', 'Portsmouth', 'Goffstown', 'Laconia', 'Hampton', 'Milford', 'Durham', 'Conway', 'Claremont', 'Lebanon', 'Berlin', 'Somersworth'],
  'nh': ['Manchester', 'Nashua', 'Concord', 'Dover', 'Rochester', 'Salem', 'Merrimack', 'Derry', 'Londonderry', 'Portsmouth'],

  'new jersey': ['Newark', 'Jersey City', 'Paterson', 'Elizabeth', 'Edison', 'Woodbridge', 'Lakewood', 'Toms River', 'Hamilton', 'Trenton', 'Clifton', 'Camden', 'Brick', 'Cherry Hill', 'Passaic', 'Middletown', 'Union City', 'Old Bridge', 'Gloucester Township', 'East Orange', 'Parsippany', 'Vineland', 'Union', 'New Brunswick', 'Piscataway', 'Wayne', 'Bayonne', 'Howell', 'Irvington', 'Long Branch', 'East Brunswick', 'Hackensack', 'North Bergen', 'Sayreville', 'Perth Amboy', 'West New York', 'Plainfield', 'Bloomfield', 'Kearny', 'Linden', 'Atlantic City', 'Fair Lawn', 'West Orange', 'Manalapan'],
  'nj': ['Newark', 'Jersey City', 'Paterson', 'Elizabeth', 'Edison', 'Woodbridge', 'Lakewood', 'Toms River', 'Hamilton', 'Trenton', 'Clifton', 'Camden', 'Brick', 'Cherry Hill', 'Middletown', 'Union City', 'Gloucester Township', 'East Orange'],

  'new mexico': ['Albuquerque', 'Las Cruces', 'Rio Rancho', 'Santa Fe', 'Roswell', 'Farmington', 'Clovis', 'Hobbs', 'Alamogordo', 'Carlsbad', 'Gallup', 'Sunland Park', 'Las Vegas', 'Los Lunas', 'Artesia', 'Lovington', 'Silver City', 'Deming', 'Anthony', 'Chaparral', 'Portales', 'Ruidoso', 'Aztec'],
  'nm': ['Albuquerque', 'Las Cruces', 'Rio Rancho', 'Santa Fe', 'Roswell', 'Farmington', 'Clovis', 'Hobbs', 'Alamogordo', 'Carlsbad'],

  'new york': ['New York City', 'Buffalo', 'Yonkers', 'Rochester', 'Syracuse', 'Albany', 'New Rochelle', 'Mount Vernon', 'Schenectady', 'Utica', 'White Plains', 'Hempstead', 'Troy', 'Niagara Falls', 'Binghamton', 'Freeport', 'Valley Stream', 'Levittown', 'Elmira', 'Amherst', 'Poughkeepsie', 'Huntington', 'North Hempstead', 'Babylon', 'Islip', 'Brookhaven', 'Ramapo', 'Greenburgh', 'Clarkstown', 'Colonie', 'Cheektowaga', 'Greece', 'West Seneca', 'Irondequoit', 'Ithaca', 'Middletown', 'Spring Valley', 'Newburgh', 'Jamestown', 'Saratoga Springs', 'Kingston', 'Brentwood', 'Ossining', 'Peekskill', 'Tonawanda', 'Lackawanna', 'Lindenhurst', 'Long Beach'],
  'ny': ['New York City', 'Buffalo', 'Yonkers', 'Rochester', 'Syracuse', 'Albany', 'New Rochelle', 'Mount Vernon', 'Schenectady', 'Utica', 'White Plains', 'Hempstead', 'Troy', 'Niagara Falls', 'Binghamton', 'Elmira', 'Poughkeepsie', 'Amherst', 'Saratoga Springs', 'Ithaca'],

  'north carolina': ['Charlotte', 'Raleigh', 'Greensboro', 'Durham', 'Winston-Salem', 'Fayetteville', 'Cary', 'Wilmington', 'High Point', 'Concord', 'Gastonia', 'Greenville', 'Asheville', 'Jacksonville', 'Chapel Hill', 'Huntersville', 'Rocky Mount', 'Burlington', 'Wilson', 'Kannapolis', 'Apex', 'Wake Forest', 'Goldsboro', 'Hickory', 'Indian Trail', 'Mooresville', 'Monroe', 'Sanford', 'Salisbury', 'New Bern', 'Statesville', 'Asheboro', 'Thomasville', 'Matthews', 'Cornelius', 'Garner', 'Clayton', 'Kernersville', 'Fuquay-Varina', 'Mint Hill'],
  'nc': ['Charlotte', 'Raleigh', 'Greensboro', 'Durham', 'Winston-Salem', 'Fayetteville', 'Cary', 'Wilmington', 'High Point', 'Concord', 'Gastonia', 'Greenville', 'Asheville', 'Jacksonville', 'Chapel Hill', 'Huntersville', 'Rocky Mount'],

  'north dakota': ['Fargo', 'Bismarck', 'Grand Forks', 'Minot', 'West Fargo', 'Williston', 'Dickinson', 'Mandan', 'Jamestown', 'Wahpeton', 'Devils Lake', 'Valley City', 'Grafton', 'Beulah', 'Rugby', 'Lisbon'],
  'nd': ['Fargo', 'Bismarck', 'Grand Forks', 'Minot', 'West Fargo', 'Williston', 'Dickinson', 'Mandan', 'Jamestown'],

  'ohio': ['Columbus', 'Cleveland', 'Cincinnati', 'Toledo', 'Akron', 'Dayton', 'Parma', 'Canton', 'Youngstown', 'Lorain', 'Hamilton', 'Springfield', 'Kettering', 'Elyria', 'Lakewood', 'Cuyahoga Falls', 'Euclid', 'Middletown', 'Mansfield', 'Newark', 'Mentor', 'Cleveland Heights', 'Beavercreek', 'Strongsville', 'Dublin', 'Fairfield', 'Lancaster', 'Marion', 'Westerville', 'Lima', 'Findlay', 'Fairborn', 'Warren', 'Brunswick', 'North Olmsted', 'Huber Heights', 'North Ridgeville', 'Green', 'Medina', 'Gahanna', 'Stow', 'Reynoldsburg', 'Hilliard', 'Upper Arlington', 'Brook Park'],
  'oh': ['Columbus', 'Cleveland', 'Cincinnati', 'Toledo', 'Akron', 'Dayton', 'Parma', 'Canton', 'Youngstown', 'Lorain', 'Hamilton', 'Springfield', 'Kettering', 'Elyria', 'Lakewood', 'Cuyahoga Falls', 'Euclid', 'Middletown'],

  'oklahoma': ['Oklahoma City', 'Tulsa', 'Norman', 'Broken Arrow', 'Lawton', 'Edmond', 'Moore', 'Midwest City', 'Stillwater', 'Enid', 'Muskogee', 'Bartlesville', 'Owasso', 'Shawnee', 'Yukon', 'Ardmore', 'Ponca City', 'Duncan', 'Del City', 'Bixby', 'Jenks', 'Sapulpa', 'Sand Springs', 'Claremore', 'Weatherford', 'Tahlequah', 'Guthrie', 'El Reno', 'McAlester', 'Altus', 'Ada', 'Durant', 'Bethany'],
  'ok': ['Oklahoma City', 'Tulsa', 'Norman', 'Broken Arrow', 'Lawton', 'Edmond', 'Moore', 'Midwest City', 'Stillwater', 'Enid', 'Muskogee', 'Bartlesville', 'Owasso', 'Shawnee'],

  'oregon': ['Portland', 'Salem', 'Eugene', 'Gresham', 'Hillsboro', 'Beaverton', 'Bend', 'Medford', 'Springfield', 'Corvallis', 'Albany', 'Tigard', 'Lake Oswego', 'Keizer', 'Grants Pass', 'Oregon City', 'McMinnville', 'Redmond', 'Tualatin', 'Ashland', 'Wilsonville', 'Sherwood', 'Happy Valley', 'Troutdale', 'Roseburg', 'Forest Grove', 'Central Point', 'Coos Bay', 'Klamath Falls', 'Newberg', 'Aloha'],
  'or': ['Portland', 'Salem', 'Eugene', 'Gresham', 'Hillsboro', 'Beaverton', 'Bend', 'Medford', 'Springfield', 'Corvallis', 'Albany', 'Tigard', 'Lake Oswego', 'Grants Pass'],

  'pennsylvania': ['Philadelphia', 'Pittsburgh', 'Allentown', 'Erie', 'Reading', 'Scranton', 'Bethlehem', 'Lancaster', 'Harrisburg', 'Altoona', 'York', 'Wilkes-Barre', 'Chester', 'Easton', 'Lebanon', 'Abington', 'Bensalem', 'Lower Merion', 'Haverford', 'Cheltenham', 'Upper Darby', 'Millcreek', 'Whitehall', 'Penn Hills', 'Monroeville', 'Bethel Park', 'Northampton', 'Hazleton', 'Pottsville', 'Norristown', 'Johnstown', 'McKeesport', 'New Castle', 'State College', 'Chambersburg', 'Carlisle', 'Levittown', 'King of Prussia'],
  'pa': ['Philadelphia', 'Pittsburgh', 'Allentown', 'Erie', 'Reading', 'Scranton', 'Bethlehem', 'Lancaster', 'Harrisburg', 'Altoona', 'York', 'Wilkes-Barre', 'Chester', 'Norristown', 'State College'],

  'rhode island': ['Providence', 'Warwick', 'Cranston', 'Pawtucket', 'East Providence', 'Woonsocket', 'Coventry', 'Cumberland', 'North Providence', 'South Kingstown', 'West Warwick', 'Johnston', 'North Smithfield', 'Bristol', 'Smithfield', 'Lincoln', 'Westerly', 'Portsmouth', 'Barrington', 'Scituate'],
  'ri': ['Providence', 'Warwick', 'Cranston', 'Pawtucket', 'East Providence', 'Woonsocket', 'Coventry', 'Cumberland', 'North Providence', 'South Kingstown'],

  'south carolina': ['Charleston', 'Columbia', 'North Charleston', 'Mount Pleasant', 'Rock Hill', 'Greenville', 'Summerville', 'Goose Creek', 'Hilton Head Island', 'Sumter', 'Florence', 'Spartanburg', 'Aiken', 'Anderson', 'Conway', 'Myrtle Beach', 'Greer', 'Mauldin', 'Greenwood', 'Newberry', 'Lexington', 'Bluffton', 'Irmo', 'Simpsonville', 'Gaffney', 'Beaufort', 'Georgetown', 'Lancaster', 'Orangeburg', 'Easley', 'Cayce', 'Hartsville'],
  'sc': ['Charleston', 'Columbia', 'North Charleston', 'Mount Pleasant', 'Rock Hill', 'Greenville', 'Summerville', 'Goose Creek', 'Hilton Head Island', 'Sumter', 'Florence', 'Spartanburg', 'Aiken', 'Anderson'],

  'south dakota': ['Sioux Falls', 'Rapid City', 'Aberdeen', 'Brookings', 'Watertown', 'Mitchell', 'Yankton', 'Pierre', 'Huron', 'Vermillion', 'Spearfish', 'Box Elder', 'Mobridge', 'Lead', 'Madison', 'Hot Springs'],
  'sd': ['Sioux Falls', 'Rapid City', 'Aberdeen', 'Brookings', 'Watertown', 'Mitchell', 'Yankton', 'Pierre', 'Huron', 'Vermillion'],

  'tennessee': ['Nashville', 'Memphis', 'Knoxville', 'Chattanooga', 'Clarksville', 'Murfreesboro', 'Franklin', 'Jackson', 'Johnson City', 'Bartlett', 'Hendersonville', 'Kingsport', 'Collierville', 'Cleveland', 'Smyrna', 'Germantown', 'Brentwood', 'Columbia', 'Spring Hill', 'La Vergne', 'Cookeville', 'Maryville', 'Mount Juliet', 'Lebanon', 'Morristown', 'Gallatin', 'Oak Ridge', 'Millington', 'Dickson', 'Greeneville', 'Athens', 'Shelbyville', 'Elizabethton'],
  'tn': ['Nashville', 'Memphis', 'Knoxville', 'Chattanooga', 'Clarksville', 'Murfreesboro', 'Franklin', 'Jackson', 'Johnson City', 'Bartlett', 'Hendersonville', 'Kingsport', 'Collierville', 'Cleveland', 'Brentwood'],

  'texas': ['Houston', 'San Antonio', 'Dallas', 'Austin', 'Fort Worth', 'El Paso', 'Arlington', 'Corpus Christi', 'Plano', 'Laredo', 'Lubbock', 'Garland', 'Irving', 'Amarillo', 'Grand Prairie', 'McKinney', 'Frisco', 'Killeen', 'Mesquite', 'McAllen', 'Carrollton', 'Denton', 'Midland', 'Waco', 'Pearland', 'Odessa', 'Abilene', 'Round Rock', 'Beaumont', 'The Woodlands', 'Tyler', 'Richardson', 'Lewisville', 'San Angelo', 'Allen', 'Edinburg', 'League City', 'Sugar Land', 'Longview', 'Mission', 'Bryan', 'Wichita Falls', 'Baytown', 'Conroe', 'College Station', 'Pasadena', 'Rowlett', 'Katy', 'Pharr', 'New Braunfels', 'Flower Mound', 'Mansfield', 'Georgetown', 'Cedar Park', 'Pflugerville', 'Atascocita', 'Temple', 'Harlingen'],
  'tx': ['Houston', 'San Antonio', 'Dallas', 'Austin', 'Fort Worth', 'El Paso', 'Arlington', 'Corpus Christi', 'Plano', 'Laredo', 'Lubbock', 'Garland', 'Irving', 'Amarillo', 'McKinney', 'Frisco', 'Killeen', 'Mesquite', 'McAllen', 'Carrollton', 'Denton', 'Midland', 'Waco', 'Pearland'],

  'utah': ['Salt Lake City', 'West Valley City', 'Provo', 'West Jordan', 'Orem', 'Sandy', 'Ogden', 'St. George', 'Layton', 'South Jordan', 'Lehi', 'Millcreek', 'Taylorsville', 'Logan', 'Murray', 'Draper', 'Bountiful', 'Riverton', 'Roy', 'Spanish Fork', 'Pleasant Grove', 'Cottonwood Heights', 'Herriman', 'American Fork', 'Springville', 'Cedar City', 'Clearfield', 'West Haven', 'Kaysville', 'North Ogden', 'Syracuse', 'Magna', 'Clinton', 'Tooele', 'Midvale'],
  'ut': ['Salt Lake City', 'West Valley City', 'Provo', 'West Jordan', 'Orem', 'Sandy', 'Ogden', 'St. George', 'Layton', 'South Jordan', 'Lehi', 'Logan', 'Murray', 'Draper', 'Bountiful'],

  'vermont': ['Burlington', 'South Burlington', 'Rutland', 'Essex', 'Colchester', 'Bennington', 'Brattleboro', 'Williston', 'Shelburne', 'Milton', 'Hartford', 'Montpelier', 'Barre', 'Middlebury', 'Newport', 'St. Johnsbury', 'Vergennes', 'Morristown', 'Swanton'],
  'vt': ['Burlington', 'South Burlington', 'Rutland', 'Essex', 'Colchester', 'Bennington', 'Brattleboro', 'Montpelier', 'Barre'],

  'washington': ['Seattle', 'Spokane', 'Tacoma', 'Vancouver', 'Bellevue', 'Kent', 'Everett', 'Renton', 'Spokane Valley', 'Federal Way', 'Bellingham', 'Kirkland', 'Kennewick', 'Yakima', 'Redmond', 'Marysville', 'Pasco', 'South Hill', 'Shoreline', 'Richland', 'Lakewood', 'Sammamish', 'Burien', 'Olympia', 'Lacey', 'Edmonds', 'Puyallup', 'Bremerton', 'Lynnwood', 'Auburn', 'Bothell', 'Kenmore', 'Mount Vernon', 'Tukwila', 'Walla Walla', 'Pullman', 'Moses Lake', 'Wenatchee', 'Longview'],
  'wa': ['Seattle', 'Spokane', 'Tacoma', 'Vancouver', 'Bellevue', 'Kent', 'Everett', 'Renton', 'Federal Way', 'Bellingham', 'Kirkland', 'Kennewick', 'Yakima', 'Redmond', 'Marysville', 'Shoreline', 'Richland', 'Lakewood', 'Sammamish', 'Olympia'],

  'west virginia': ['Charleston', 'Huntington', 'Parkersburg', 'Morgantown', 'Wheeling', 'Weirton', 'Fairmont', 'Martinsburg', 'Beckley', 'Clarksburg', 'South Charleston', 'Teays Valley', 'St. Albans', 'Vienna', 'Bluefield', 'Dunbar', 'Bridgeport', 'Elkins', 'Cross Lanes', 'Oak Hill'],
  'wv': ['Charleston', 'Huntington', 'Parkersburg', 'Morgantown', 'Wheeling', 'Weirton', 'Fairmont', 'Martinsburg', 'Beckley', 'Clarksburg'],

  'wisconsin': ['Milwaukee', 'Madison', 'Green Bay', 'Kenosha', 'Racine', 'Appleton', 'Waukesha', 'Oshkosh', 'Eau Claire', 'Janesville', 'West Allis', 'La Crosse', 'Sheboygan', 'Wauwatosa', 'Fond du Lac', 'New Berlin', 'Wausau', 'Brookfield', 'Beloit', 'Greenfield', 'Menomonee Falls', 'Oak Creek', 'Franklin', 'Manitowoc', 'West Bend', 'Marshfield', 'Cudahy', 'Sun Prairie', 'Superior', 'South Milwaukee', 'Mequon', 'De Pere', 'Neenah', 'Mount Pleasant'],
  'wi': ['Milwaukee', 'Madison', 'Green Bay', 'Kenosha', 'Racine', 'Appleton', 'Waukesha', 'Oshkosh', 'Eau Claire', 'Janesville', 'West Allis', 'La Crosse', 'Sheboygan', 'Wauwatosa'],

  'wyoming': ['Cheyenne', 'Casper', 'Laramie', 'Gillette', 'Rock Springs', 'Sheridan', 'Green River', 'Evanston', 'Riverton', 'Jackson', 'Cody', 'Lander', 'Torrington', 'Douglas', 'Powell', 'Worland', 'Buffalo', 'Rawlins', 'Thermopolis', 'Wheatland'],
  'wy': ['Cheyenne', 'Casper', 'Laramie', 'Gillette', 'Rock Springs', 'Sheridan', 'Green River', 'Evanston', 'Riverton', 'Jackson'],

  // Canadian Provinces
  'british columbia': ['Vancouver', 'Surrey', 'Burnaby', 'Richmond', 'Kelowna', 'Abbotsford', 'Coquitlam', 'Langley', 'Saanich', 'Delta', 'Kamloops', 'Nanaimo', 'North Vancouver', 'Maple Ridge', 'New Westminster', 'Port Coquitlam', 'Prince George', 'Victoria', 'Chilliwack', 'Penticton', 'Vernon', 'Mission', 'Port Moody', 'Langford', 'West Kelowna'],
  'bc': ['Vancouver', 'Surrey', 'Burnaby', 'Richmond', 'Kelowna', 'Abbotsford', 'Coquitlam', 'Langley', 'Delta', 'Kamloops', 'Nanaimo', 'Victoria', 'Chilliwack', 'Prince George'],

  'quebec': ['Montreal', 'Quebec City', 'Laval', 'Longueuil', 'Sherbrooke', 'Gatineau', 'Saguenay', 'Lévis', 'Trois-Rivières', 'Terrebonne', 'Saint-Jean-sur-Richelieu', 'Chateauguay', 'Brossard', 'Repentigny', 'Drummondville', 'Saint-Jérôme', 'Blainville', 'Granby', 'Mirabel', 'Mascouche'],
  'qc': ['Montreal', 'Quebec City', 'Laval', 'Longueuil', 'Sherbrooke', 'Gatineau', 'Saguenay', 'Lévis', 'Trois-Rivières', 'Terrebonne'],

  'alberta': ['Calgary', 'Edmonton', 'Red Deer', 'Lethbridge', 'St. Albert', 'Medicine Hat', 'Grande Prairie', 'Airdrie', 'Spruce Grove', 'Leduc', 'Fort McMurray', 'Okotoks', 'Cochrane', 'Chestermere', 'Fort Saskatchewan', 'Lloydminster', 'Camrose', 'Cold Lake', 'Lacombe', 'Wetaskiwin'],
  'ab': ['Calgary', 'Edmonton', 'Red Deer', 'Lethbridge', 'St. Albert', 'Medicine Hat', 'Grande Prairie', 'Airdrie', 'Spruce Grove', 'Fort McMurray'],

  'saskatchewan': ['Saskatoon', 'Regina', 'Prince Albert', 'Moose Jaw', 'Swift Current', 'Yorkton', 'North Battleford', 'Estevan', 'Weyburn', 'Lloydminster', 'Martensville', 'Warman', 'Meadow Lake', 'Humboldt', 'Battleford'],
  'sk': ['Saskatoon', 'Regina', 'Prince Albert', 'Moose Jaw', 'Swift Current', 'Yorkton', 'North Battleford', 'Estevan', 'Weyburn'],

  'manitoba': ['Winnipeg', 'Brandon', 'Steinbach', 'Thompson', 'Portage la Prairie', 'Winkler', 'Selkirk', 'Morden', 'Dauphin', 'The Pas', 'Flin Flon', 'Swan River', 'Niverville', 'Stonewall', 'Neepawa'],
  'mb': ['Winnipeg', 'Brandon', 'Steinbach', 'Thompson', 'Portage la Prairie', 'Winkler', 'Selkirk', 'Morden', 'Dauphin'],
}

/**
 * A national city list, derived from STATE_MAP rather than written out.
 *
 * Four cities per state across all 50 states plus DC and the territories —
 * ~200 cities. Derived so it cannot drift from the per-state lists, and
 * ordered state by state so a truncated run still covers the country rather
 * than finishing California.
 *
 * Only the full-name state keys are used; the two-letter aliases hold the same
 * cities and would double every entry.
 */
const CITIES_PER_STATE_NATIONAL = 4

function buildNationalCities(): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const key of Object.keys(STATE_MAP)) {
    if (key.length <= 2) continue          // skip 'al', 'ak', … aliases
    for (const city of STATE_MAP[key].slice(0, CITIES_PER_STATE_NATIONAL)) {
      if (seen.has(city)) continue
      seen.add(city)
      out.push(city)
    }
  }
  return out
}

export const NATIONAL_CITIES = buildNationalCities()

export function expandLocationStatic(location: string): string[] | null {
  const key = location.toLowerCase().trim()

  // National first: "united states" would otherwise partial-match a state.
  if (['united states', 'usa', 'us', 'nationwide', 'national', 'america'].includes(key)) {
    return NATIONAL_CITIES
  }

  // Check metro map first (exact match)
  if (LOCATION_MAP[key]) return LOCATION_MAP[key]

  // Check state/province map (exact match — covers full name and abbreviation)
  if (STATE_MAP[key]) return STATE_MAP[key]

  // Partial match in the metro map. Both sides are length-guarded: without it
  // a two-character input matches any key containing those letters, so "ny"
  // would silently expand to whichever metro happened to contain "ny".
  for (const [k, v] of Object.entries(LOCATION_MAP)) {
    if (k.length > 3 && key.includes(k)) return v
    if (key.length > 3 && k.includes(key)) return v
  }

  // Partial match in state map (e.g. "new york state" → "new york")
  for (const [k, v] of Object.entries(STATE_MAP)) {
    if (key.includes(k) && k.length > 2) return v
  }

  return null
}


/**
 * Expand a location into the city list to query.
 *
 * Falls back to the location itself, so an unknown phrase still produces one
 * sensible query instead of nothing.
 */
export function expandLocation(location: string): string[] {
  return expandLocationStatic(location) ?? [location]
}
