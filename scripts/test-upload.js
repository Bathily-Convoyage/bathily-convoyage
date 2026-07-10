import fs from 'fs';

async function testUpload() {
  const formData = new FormData();
  // just write a dummy text file
  fs.writeFileSync('test.txt', 'hello world');
  
  // wait we need to use a Blob/File or something if using native fetch in Node 22
  // Or we can use curl via child_process
}
