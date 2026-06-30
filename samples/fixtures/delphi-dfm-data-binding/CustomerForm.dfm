object CustomerForm: TCustomerForm
  object cdsMaster: TClientDataSet
  end
  object dsMaster: TDataSource
    DataSet = cdsMaster
  end
  object DBEdit1: TDBEdit
    DataSource = dsMaster
    DataField = 'CUST_NAME'
  end
  object DBCheckBox1: TDBCheckBox
    DataSource = dsMaster
    DataField = 'ACTIVE'
  end
  object DBGrid1: TDBGrid
    DataSource = dsMaster
    Columns = <
      item
        FieldName = 'CUST_ID'
      end
      item
        FieldName = 'CUST_NAME'
      end
    >
  end
end
