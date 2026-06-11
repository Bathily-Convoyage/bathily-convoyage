// test-supabase-clients.js
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = "https://yzfulgmmngvenxvdvgbp.supabase.co";
const supabaseKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl6ZnVsZ21tbmd2ZW54dmR2Z2JwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA5MTQ3NDYsImV4cCI6MjA5NjQ5MDc0Nn0._LK4AvUNl5mJ6Muj5K8hGCWEj5pR_-hKt57AtPd6FSc";

const supabase = createClient(supabaseUrl, supabaseKey);

async function run() {
  const emailToCheck = "mrboubsofficiel@gmail.com";
  console.log(`Checking email in Supabase: ${emailToCheck}`);
  
  const { data, error } = await supabase
    .from('clients')
    .select('*')
    .eq('email', emailToCheck)
    .maybeSingle();

  if (error) {
    console.error("Error querying clients:", error);
  } else {
    console.log("Query Result:", data);
  }
}

run();
